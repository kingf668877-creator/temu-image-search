const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createExecutor } = require('./executors');

class BatchService {
  constructor(options = {}) {
    this.runtimeDir = options.runtimeDir || path.resolve(__dirname, '..', 'runtime');
    this.executor = options.executor || createExecutor(options.mode);
    this.batches = new Map();
    this.queue = [];
    this.running = false;
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

  create(items) {
    if (!items.length) throw Object.assign(new Error('没有可处理的图片'), { code: 'NO_IMAGES' });
    const batch = {
      id: randomUUID(),
      status: 'queued',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      items: items.map((item, index) => ({
        id: randomUUID(),
        index,
        name: item.name || `图片-${index + 1}`,
        source: item.source || item.name || '',
        previewUrl: item.previewUrl || null,
        localPath: item.localPath,
        status: item.error ? 'failed' : 'queued',
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        products: [],
        error: item.error || null,
      })),
    };
    this.batches.set(batch.id, batch);
    const queuedItems = batch.items.filter((item) => item.status === 'queued');
    queuedItems.forEach((item) => this.queue.push({ batchId: batch.id, itemId: item.id }));
    if (!queuedItems.length) {
      batch.status = 'failed';
      batch.finishedAt = new Date().toISOString();
    }
    this.persist(batch);
    this.drain();
    return this.publicBatch(batch, false);
  }

  get(batchId, includeProducts = true) {
    const batch = this.batches.get(batchId);
    return batch ? this.publicBatch(batch, includeProducts) : null;
  }

  retry(batchId, itemId) {
    const batch = this.batches.get(batchId);
    const item = batch && batch.items.find((entry) => entry.id === itemId);
    if (!item) return null;
    if (item.status !== 'failed') throw Object.assign(new Error('只能重试失败项'), { code: 'ITEM_NOT_FAILED' });
    Object.assign(item, { status: 'queued', error: null, finishedAt: null, durationMs: null });
    batch.status = 'queued';
    batch.finishedAt = null;
    this.queue.push({ batchId, itemId });
    this.persist(batch);
    this.drain();
    return this.publicBatch(batch, true);
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
      summary: this.summary(batch),
      items: batch.items.map((item) => ({
        ...item,
        localPath: undefined,
        products: includeProducts ? item.products : undefined,
        productCount: item.products.length,
      })),
    };
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const job = this.queue.shift();
      const batch = this.batches.get(job.batchId);
      const item = batch && batch.items.find((entry) => entry.id === job.itemId);
      if (!item || item.status !== 'queued') continue;
      batch.status = 'running';
      item.status = 'running';
      item.startedAt = new Date().toISOString();
      item.attempts += 1;
      const started = Date.now();
      this.persist(batch);
      try {
        item.products = await this.executor(item, (stage) => {
          item.stage = stage;
          this.persist(batch);
        });
        item.status = 'succeeded';
      } catch (error) {
        item.status = 'failed';
        item.error = { code: error.code || 'SEARCH_FAILED', message: String(error.message || error) };
      }
      item.finishedAt = new Date().toISOString();
      item.durationMs = Date.now() - started;
      const counts = this.summary(batch);
      if (counts.queued === 0 && counts.running === 0) {
        batch.status = counts.failed === counts.total ? 'failed' : 'completed';
        batch.finishedAt = new Date().toISOString();
      }
      this.persist(batch);
    }
    this.running = false;
  }

  persist(batch) {
    fs.writeFileSync(path.join(this.runtimeDir, `${batch.id}.json`), JSON.stringify(batch, null, 2));
  }
}

module.exports = { BatchService };
