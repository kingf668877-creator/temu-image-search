const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createExecutor } = require('./executors');
const { ResultCache } = require('./cache');

class BatchService {
  constructor(options = {}) {
    this.runtimeDir = options.runtimeDir || path.resolve(__dirname, '..', 'runtime');
    this.executor = options.executor || createExecutor(options.mode);
    this.cache = options.cache || new ResultCache({
      cacheDir: path.join(this.runtimeDir, 'cache'),
    });
    this.batches = new Map();
    this.deletedBatchIds = new Set();
    this.queue = [];
    this.activeWorkers = 0;
    // 并发上限：调用方不传时默认 1（向后兼容旧行为）；env TEMU_BATCH_CONCURRENCY 可全局提高
    if (options.concurrency !== undefined && options.concurrency !== null) {
      this.concurrency = Math.max(1, Number(options.concurrency));
    } else if (process.env.TEMU_BATCH_CONCURRENCY !== undefined) {
      this.concurrency = Math.max(1, Number(process.env.TEMU_BATCH_CONCURRENCY));
    } else {
      this.concurrency = 1;
    }
    this.deleteCompletedBatches = Boolean(options.deleteCompletedBatches);
    this.onProgress = options.onProgress || (() => {});
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    this.restore();
  }

  restore() {
    for (const file of fs.readdirSync(this.runtimeDir).filter((name) => name.endsWith('.json'))) {
      try {
        const batch = JSON.parse(fs.readFileSync(path.join(this.runtimeDir, file), 'utf8'));
        if (!batch || !batch.id || !Array.isArray(batch.items)) continue;
        if (batch.status === 'running') batch.status = 'interrupted';
        batch.items.forEach((item) => {
          if (item.status === 'running') {
            item.status = 'failed';
            item.error = { code: 'SERVICE_RESTARTED', message: '服务重启中断了该任务，请重试' };
          }
        });
        this.batches.set(batch.id, batch);
      } catch {}
    }
  }

  create(items, options = {}) {
    if (!items.length) throw Object.assign(new Error('没有可处理的图片'), { code: 'NO_IMAGES' });
    const cacheEnabled = options.cache !== false;
    const batch = {
      id: randomUUID(),
      status: 'created',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      items: items.map((item, index) => ({
        id: randomUUID(),
        index,
        name: item.name || `图片-${index + 1}`,
        source: item.source || item.name || '',
        previewUrl: item.previewUrl || null,
        localPath: item.localPath,
        hash: null,
        status: item.error ? 'failed' : 'queued',
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        products: [],
        error: item.error || null,
        cacheHit: null,
      })),
    };
    if (cacheEnabled) {
      batch.items.forEach((item) => {
        if (item.status !== 'queued' || !item.localPath) return;
        const hash = this.cache.hashFile(item.localPath);
        if (!hash) return;
        const hit = this.cache.get(hash);
        if (!hit || !Array.isArray(hit.products) || !hit.products.length) return;
        item.hash = hash;
        item.products = hit.products;
        item.status = 'succeeded';
        item.startedAt = item.startedAt || batch.createdAt;
        item.finishedAt = hit.finishedAt || new Date().toISOString();
        item.durationMs = 0;
        item.cacheHit = {
          hash,
          source: hit.source || 'cache',
          finishedAt: hit.finishedAt || null,
        };
      });
    }
    this.deletedBatchIds.delete(batch.id);
    this.batches.set(batch.id, batch);
    const queuedItems = batch.items.filter((item) => item.status === 'queued');
    if (!queuedItems.length) {
      batch.status = batch.items.every((item) => item.status === 'succeeded') ? 'completed' : 'failed';
      batch.finishedAt = new Date().toISOString();
    }
    this.persist(batch);
    if (options.autoStart !== false && queuedItems.length) this.start(batch.id);
    return this.publicBatch(batch, false);
  }

  list(includeProducts = false) {
    return [...this.batches.values()]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((batch) => this.publicBatch(batch, includeProducts));
  }

  get(batchId, includeProducts = true) {
    const batch = this.batches.get(batchId);
    return batch ? this.publicBatch(batch, includeProducts) : null;
  }

  start(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) return null;
    if (['completed', 'running', 'stopped', 'interrupted'].includes(batch.status)) return this.publicBatch(batch, false);
    const queuedItems = batch.items.filter((item) => item.status === 'queued');
    if (!queuedItems.length) {
      batch.status = 'failed';
      batch.finishedAt = new Date().toISOString();
      this.persist(batch);
      return this.publicBatch(batch, false);
    }
    batch.status = 'queued';
    batch.finishedAt = null;
    queuedItems.forEach((item) => {
      const exists = this.queue.some((job) => job.batchId === batch.id && job.itemId === item.id);
      if (!exists) this.queue.push({ batchId: batch.id, itemId: item.id });
    });
    this.persist(batch);
    this.spawnWorkers();
    return this.publicBatch(batch, false);
  }

  retry(batchId, itemId) {
    const batch = this.batches.get(batchId);
    const item = batch && batch.items.find((entry) => entry.id === itemId);
    if (!item) return null;
    if (item.status !== 'failed') throw Object.assign(new Error('只能重试失败项'), { code: 'ITEM_NOT_FAILED' });
    Object.assign(item, { status: 'queued', error: null, finishedAt: null, durationMs: null, products: [] });
    batch.status = 'queued';
    batch.finishedAt = null;
    this.queue.push({ batchId, itemId });
    this.persist(batch);
    this.spawnWorkers();
    return this.publicBatch(batch, true);
  }

  stop(batchId, options = {}) {
    const batch = this.batches.get(batchId);
    if (!batch) return null;
    this.queue = this.queue.filter((job) => job.batchId !== batchId);
    const now = new Date().toISOString();
    batch.items.forEach((item) => {
      item.products = [];
      if (item.status === 'queued') {
        item.status = 'failed';
        item.error = { code: 'TASK_STOPPED', message: '任务已停止，已清理该图片结果' };
        item.finishedAt = now;
      } else if (item.status === 'running') {
        item.error = { code: 'TASK_STOPPING', message: '任务正在停止，已清理已跑商品结果' };
      }
    });
    batch.status = 'stopped';
    batch.finishedAt = now;
    if (options.delete !== false) {
      this.delete(batchId);
      return { id: batchId, status: 'deleted' };
    }
    this.persist(batch);
    return this.publicBatch(batch, true);
  }

  delete(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) return false;
    this.queue = this.queue.filter((job) => job.batchId !== batchId);
    batch.items.forEach((item) => {
      item.products = [];
    });
    this.deletedBatchIds.add(batchId);
    this.batches.delete(batchId);
    const file = path.join(this.runtimeDir, `${batchId}.json`);
    try { fs.rmSync(file, { force: true }); } catch {}
    return true;
  }

  clearAll() {
    const ids = Array.from(this.batches.keys());
    ids.forEach((id) => this.delete(id));
    this.queue = [];
    return ids.length;
  }

  summary(batch) {
    const counts = { total: batch.items.length, queued: 0, running: 0, succeeded: 0, failed: 0 };
    batch.items.forEach((item) => { if (counts[item.status] !== undefined) counts[item.status] += 1; });
    return counts;
  }

  publicBatch(batch, includeProducts) {
    return {
      id: batch.id,
      status: batch.status,
      createdAt: batch.createdAt,
      finishedAt: batch.finishedAt,
      concurrency: this.concurrency,
      activeWorkers: this.activeWorkers,
      summary: this.summary(batch),
      items: batch.items.map((item) => ({
        ...item,
        hash: item.hash || null,
        localPath: undefined,
        products: includeProducts ? item.products : undefined,
        productCount: item.products.length,
      })),
    };
  }

  // 启动 worker 直到达到 concurrency 上限或队列空
  spawnWorkers() {
    while (this.activeWorkers < this.concurrency && this.queue.length) {
      this.activeWorkers += 1;
      // 不 await —— worker 跑自己的
      this.runWorker().catch(() => {}).finally(() => {
        this.activeWorkers = Math.max(0, this.activeWorkers - 1);
        // 一个 worker 退出后尝试启新 worker
        if (this.queue.length) this.spawnWorkers();
        else this.emitProgress(null, null, 'idle');
      });
    }
  }

  async runWorker() {
    // 取队首 job
    while (this.queue.length) {
      const job = this.queue.shift();
      if (this.deletedBatchIds.has(job.batchId)) continue;
      const batch = this.batches.get(job.batchId);
      const item = batch && batch.items.find((entry) => entry.id === job.itemId);
      if (!item || item.status !== 'queued') continue;
      batch.status = 'running';
      item.status = 'running';
      item.startedAt = new Date().toISOString();
      item.attempts += 1;
      const started = Date.now();
      this.persist(batch);
      this.emitProgress(batch.id, item.id, 'running');
      try {
        item.products = await this.executor(item, (stage) => {
          if (this.deletedBatchIds.has(job.batchId)) return;
          // 兼容旧式 { text: '执行中' } 与新式 'searching'
          if (stage && typeof stage === 'object') {
            item.stage = stage.text || JSON.stringify(stage);
          } else {
            item.stage = stage;
          }
          this.persist(batch);
          this.emitProgress(batch.id, item.id, item.stage);
        });
        if (this.deletedBatchIds.has(job.batchId)) continue;
        item.status = 'succeeded';
        this.persistCache(item);
      } catch (error) {
        if (this.deletedBatchIds.has(job.batchId)) continue;
        item.status = 'failed';
        item.error = { code: error.code || 'SEARCH_FAILED', message: String(error.message || error) };
      }
      if (this.deletedBatchIds.has(job.batchId)) continue;
      item.finishedAt = new Date().toISOString();
      item.durationMs = Date.now() - started;
      const counts = this.summary(batch);
      if (counts.queued === 0 && counts.running === 0) {
        batch.status = counts.failed === counts.total ? 'failed' : 'completed';
        batch.finishedAt = new Date().toISOString();
      }
      this.persist(batch);
      this.emitProgress(batch.id, item.id, item.status, { durationMs: item.durationMs });
    }
  }

  emitProgress(batchId, itemId, stage, extra = {}) {
    try {
      this.onProgress({
        batchId,
        itemId,
        stage,
        activeWorkers: this.activeWorkers,
        queueLength: this.queue.length,
        ...extra,
      });
    } catch {}
  }

  persist(batch) {
    if (this.deletedBatchIds.has(batch.id)) return;
    fs.writeFileSync(path.join(this.runtimeDir, `${batch.id}.json`), JSON.stringify(batch, null, 2));
  }

  persistCache(item) {
    if (!item || !Array.isArray(item.products) || !item.products.length) return false;
    const hash = item.hash || this.cache.hashFile(item.localPath);
    if (!hash) return false;
    item.hash = hash;
    return this.cache.set(hash, item.products, {
      source: 'temu-image-search',
      finishedAt: item.finishedAt || new Date().toISOString(),
    });
  }

  cacheStats() {
    return this.cache.stats();
  }
}

module.exports = { BatchService };