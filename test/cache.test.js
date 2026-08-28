const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BatchService } = require('../src/batch-service');
const { ResultCache } = require('../src/cache');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFinished(service, batchId) {
  for (let i = 0; i < 200; i += 1) {
    const batch = service.get(batchId, true);
    if (['completed', 'failed'].includes(batch.status)) return batch;
    await wait(10);
  }
  throw new Error('批次未完成');
}

function writeTempImage(dir, bytes = null) {
  const target = path.join(dir, `img-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  const buffer = bytes || crypto.randomBytes(256);
  fs.writeFileSync(target, buffer);
  return target;
}

test('ResultCache 基础读写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-cache-basic-'));
  const cache = new ResultCache({ cacheDir: dir });
  const hash = crypto.randomBytes(16).toString('hex');
  const products = [{ goodsId: 'a', title: '测试' }];

  assert.equal(cache.get(hash), null);
  assert.equal(cache.set(hash, products, { finishedAt: '2026-08-20T00:00:00.000Z' }), true);
  const hit = cache.get(hash);
  assert.ok(hit);
  assert.equal(hit.hash, hash);
  assert.deepEqual(hit.products, products);
  assert.equal(hit.source, 'temu-image-search');
});

test('ResultCache.evictIfNeeded 按 finishedAt 淘汰最旧条目', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-cache-evict-'));
  const cache = new ResultCache({ cacheDir: dir, maxEntries: 2 });
  const products = [{ goodsId: 'x' }];
  cache.set('h1', products, { finishedAt: '2026-08-20T00:00:00.000Z' });
  await wait(5);
  cache.set('h2', products, { finishedAt: '2026-08-20T00:01:00.000Z' });
  await wait(5);
  cache.set('h3', products, { finishedAt: '2026-08-20T00:02:00.000Z' });

  const stats = cache.stats();
  assert.equal(stats.entries, 2);
  assert.equal(cache.get('h1'), null);
  assert.ok(cache.get('h2'));
  assert.ok(cache.get('h3'));
});

test('ResultCache.stats 返回目录与上限', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-cache-stats-'));
  const cache = new ResultCache({ cacheDir: dir, maxEntries: 7, maxBytes: 1234 });
  const stats = cache.stats();
  assert.equal(stats.cacheDir, dir);
  assert.equal(stats.maxEntries, 7);
  assert.equal(stats.maxBytes, 1234);
  assert.equal(stats.entries, 0);
});

test('创建批次时若图片 hash 命中缓存则直接返回缓存商品', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-batch-cache-'));
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-cache-imgs-'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-cache-cache-'));

  const cache = new ResultCache({ cacheDir });
  const bytes = crypto.randomBytes(1024);
  const filePath = writeTempImage(imageDir, bytes);
  const hash = cache.hashFile(filePath);
  const cachedProducts = [{ goodsId: 'cached-1', title: 'cached' }];
  cache.set(hash, cachedProducts, { finishedAt: '2026-08-21T00:00:00.000Z' });

  let executions = 0;
  const service = new BatchService({
    executor: async () => {
      executions += 1;
      return [{ goodsId: 'fresh' }];
    },
    runtimeDir: dir,
    cache,
  });

  const created = service.create([{ name: 'cache-hit.jpg', localPath: filePath }]);
  // 命中缓存时不会进入队列，批次应立即 completed
  assert.equal(created.status, 'completed');
  assert.equal(executions, 0);
  assert.equal(created.items[0].cacheHit.hash, hash);
  const fetched = service.get(created.id, true);
  assert.deepEqual(fetched.items[0].products, cachedProducts);
});

test('成功完成的批次会写入缓存', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-batch-cache-set-'));
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-batch-imgs-'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-batch-cache-'));
  const cache = new ResultCache({ cacheDir });
  const filePath = writeTempImage(imageDir);
  const hash = cache.hashFile(filePath);

  const service = new BatchService({
    executor: async (item) => [{ goodsId: `fresh-${item.name}` }],
    runtimeDir: dir,
    cache,
  });

  const created = service.create([{ name: 'fresh.jpg', localPath: filePath }]);
  await waitFinished(service, created.id);

  const hit = cache.get(hash);
  assert.ok(hit, '缓存应当被写入');
  assert.deepEqual(hit.products, [{ goodsId: 'fresh-fresh.jpg' }]);
});

test('第二批相同图片直接走缓存，不调用 executor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-batch-cache-second-'));
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-batch-second-imgs-'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-batch-second-cache-'));
  const cache = new ResultCache({ cacheDir });

  // 第一张图片跑一次产生缓存
  const first = writeTempImage(imageDir, Buffer.from('hello'));
  const second = writeTempImage(imageDir, Buffer.from('hello')); // 字节相同 -> 同 hash
  let executions = 0;
  const service = new BatchService({
    executor: async (item) => {
      executions += 1;
      return [{ goodsId: `p-${item.name}` }];
    },
    runtimeDir: dir,
    cache,
  });

  const firstBatch = service.create([{ name: 'one.jpg', localPath: first }]);
  await waitFinished(service, firstBatch.id);
  assert.equal(executions, 1);

  const secondBatch = service.create([{ name: 'two.jpg', localPath: second }]);
  assert.equal(secondBatch.items[0].status, 'succeeded');
  assert.equal(secondBatch.items[0].cacheHit.hash, cache.hashFile(second));
  assert.equal(executions, 1, '第二次同 hash 不应触发 executor');
});

test('cache: false 可以关闭单次缓存查找', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-batch-cache-disabled-'));
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-batch-cache-off-'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-cache-off-'));
  const cache = new ResultCache({ cacheDir });
  const filePath = writeTempImage(imageDir, crypto.randomBytes(128));
  const hash = cache.hashFile(filePath);
  cache.set(hash, [{ goodsId: 'cached' }], { finishedAt: '2026-08-21T00:00:00.000Z' });

  let executions = 0;
  const service = new BatchService({
    executor: async () => {
      executions += 1;
      return [{ goodsId: 'fresh' }];
    },
    runtimeDir: dir,
    cache,
  });

  const created = service.create([{ name: 'no-cache.jpg', localPath: filePath }], { cache: false });
  await waitFinished(service, created.id);
  assert.equal(executions, 1);
  assert.equal(created.items[0].cacheHit, null);
});

test('cacheStats 暴露给 health 接口', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-cache-health-'));
  const cache = new ResultCache({ cacheDir: dir });
  const service = new BatchService({ executor: async () => [], runtimeDir: dir, cache });
  const stats = service.cacheStats();
  assert.equal(stats.cacheDir, dir);
  assert.ok(stats.entries >= 0);
  assert.ok(stats.totalBytes >= 0);
});