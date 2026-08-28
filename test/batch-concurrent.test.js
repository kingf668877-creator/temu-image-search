// 方案 C 测试：worker pool 并发跑 + 进度事件 + 排队
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BatchService } = require('../src/batch-service');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFinished(service, batchId, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const batch = service.get(batchId, true);
    if (batch && ['completed', 'failed'].includes(batch.status)) return batch;
    await wait(10);
  }
  throw new Error('批次未完成');
}

test('concurrency=1 时仍保持串行', async () => {
  let active = 0;
  let maximum = 0;
  const executor = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await wait(20);
    active -= 1;
    return [{ goodsId: 'ok' }];
  };
  const service = new BatchService({
    executor, concurrency: 1,
    runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'temu-c1-')),
  });
  const created = service.create([
    { name: 'a.jpg', localPath: 'a.jpg' },
    { name: 'b.jpg', localPath: 'b.jpg' },
    { name: 'c.jpg', localPath: 'c.jpg' },
  ]);
  const batch = await waitFinished(service, created.id);
  assert.equal(maximum, 1);
  assert.equal(batch.summary.succeeded, 3);
});

test('concurrency=4 时同时最多跑 4 个 worker', async () => {
  let active = 0;
  let maximum = 0;
  const executor = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await wait(50);
    active -= 1;
    return [{ goodsId: 'ok' }];
  };
  const service = new BatchService({
    executor, concurrency: 4,
    runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'temu-c4-')),
  });
  // 8 个 item，每个 50ms，并发 4 → 总耗时约 100ms（vs 串行 400ms）
  const items = Array.from({ length: 8 }, (_, i) => ({ name: `${i}.jpg`, localPath: `${i}.jpg` }));
  const created = service.create(items);
  const start = Date.now();
  const batch = await waitFinished(service, created.id);
  const elapsed = Date.now() - start;
  assert.equal(maximum, 4);
  assert.equal(batch.summary.succeeded, 8);
  // 8 / 4 = 2 批 × 50ms ≈ 100ms（宽松判断 ≤ 220ms 留出开销）
  assert.ok(elapsed <= 220, `8 并发 4 应 < 220ms，实际 ${elapsed}ms`);
});

test('并发跑时 onProgress 会触发', async () => {
  const progressEvents = [];
  const service = new BatchService({
    executor: async () => [{ goodsId: 'ok' }],
    concurrency: 2,
    onProgress: (event) => progressEvents.push(event),
    runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'temu-progress-')),
  });
  const created = service.create([
    { name: 'a.jpg', localPath: 'a.jpg' },
    { name: 'b.jpg', localPath: 'b.jpg' },
    { name: 'c.jpg', localPath: 'c.jpg' },
  ]);
  await waitFinished(service, created.id);
  await wait(50); // 等最后一次事件落定
  // 应该有 running/succeeded 两个阶段
  const stages = new Set(progressEvents.map((e) => e.stage));
  assert.ok(stages.has('running'), '至少有一次 running 事件');
  assert.ok(stages.has('succeeded'), '至少有一次 succeeded 事件');
  // item 级别事件应至少有 batchId / itemId / stage 字段（idle 事件可只含 stage）
  const itemEvents = progressEvents.filter((e) => e.itemId);
  assert.ok(itemEvents.length > 0, '至少有 item 级别事件');
  assert.ok(itemEvents.every((e) => e.batchId && e.itemId && e.stage));
});

test('并发 worker 中间有失败项不影响其他', async () => {
  const executor = async (item) => {
    await wait(30);
    if (item.name === 'fail.jpg') throw new Error('故意失败');
    return [{ goodsId: item.name }];
  };
  const service = new BatchService({
    executor, concurrency: 3,
    runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'temu-fail-')),
  });
  const created = service.create([
    { name: 'a.jpg', localPath: 'a.jpg' },
    { name: 'fail.jpg', localPath: 'fail.jpg' },
    { name: 'b.jpg', localPath: 'b.jpg' },
    { name: 'c.jpg', localPath: 'c.jpg' },
  ]);
  const batch = await waitFinished(service, created.id);
  assert.equal(batch.summary.succeeded, 3);
  assert.equal(batch.summary.failed, 1);
  assert.equal(batch.status, 'completed');
});

test('并发模式下 LRU cache 命中仍立即返回', async () => {
  // 用一张"已缓存"文件触发 hashFile cache hit
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-cache-'));
  // 准备一张图片
  const img = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'JFIF']);
  const tmpImg = path.join(cacheDir, 'hit.jpg');
  fs.writeFileSync(tmpImg, img);

  // 第一次跑：写入 cache
  let firstCount = 0;
  const firstService = new BatchService({
    executor: async () => { firstCount = (firstCount || 0) + 1; await wait(50); return [{ goodsId: 'one' }]; },
    concurrency: 4,
    runtimeDir: path.join(cacheDir, 'r1'),
  });
  fs.mkdirSync(path.join(cacheDir, 'r1'), { recursive: true });
  const firstBatch = firstService.create([{ name: 'hit.jpg', localPath: tmpImg }]);
  await waitFinished(firstService, firstBatch.id);
  // 从 firstService cache 目录搬到新 service 的 cache 目录（同一进程 / 不同实例共享文件）
  // 这里直接复用 firstService 的 cacheDir 让第二个 service 用同一个
  const secondRuntime = path.join(cacheDir, 'r2');
  fs.mkdirSync(secondRuntime, { recursive: true });
  // 把 firstService 的 cache 文件复制到 secondRuntime/cache 下
  const srcCache = path.join(firstService.cache.cacheDir);
  const dstCache = path.join(secondRuntime, 'cache');
  fs.mkdirSync(dstCache, { recursive: true });
  for (const file of fs.readdirSync(srcCache)) {
    fs.copyFileSync(path.join(srcCache, file), path.join(dstCache, file));
  }

  // 第二次跑：用同一个图片，期望 cache hit 立即返回，durationMs ≈ 0
  let secondCount = 0;
  const secondService = new BatchService({
    executor: async () => { secondCount += 1; await wait(50); return [{ goodsId: 'two' }]; },
    concurrency: 4,
    runtimeDir: secondRuntime,
  });
  const secondBatch = secondService.create([{ name: 'hit.jpg', localPath: tmpImg }]);
  const result = await waitFinished(secondService, secondBatch.id);
  assert.equal(secondCount, 0, '第二次应完全 cache hit，executor 不应被调用');
  assert.equal(result.summary.succeeded, 1);
  assert.ok(result.items[0].cacheHit, 'item 应标记 cacheHit');
});

test('worker pool 在 drain 完成后 activeWorkers 归零', async () => {
  let active = 0;
  let peaks = [];
  const executor = async () => {
    active += 1;
    peaks.push(active);
    await wait(20);
    active -= 1;
    return [{ goodsId: 'ok' }];
  };
  const service = new BatchService({
    executor, concurrency: 3,
    runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'temu-drain-')),
  });
  const created = service.create([
    { name: 'a.jpg', localPath: 'a.jpg' },
    { name: 'b.jpg', localPath: 'b.jpg' },
    { name: 'c.jpg', localPath: 'c.jpg' },
  ]);
  await waitFinished(service, created.id);
  await wait(50);
  assert.equal(service.activeWorkers, 0);
  assert.ok(Math.max(...peaks) >= 2, `并发峰值应 ≥2，实际 ${Math.max(...peaks)}`);
});