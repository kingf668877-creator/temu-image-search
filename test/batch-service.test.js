const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BatchService } = require('../src/batch-service');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFinished(service, batchId) {
  for (let i = 0; i < 100; i += 1) {
    const batch = service.get(batchId, true);
    if (['completed', 'failed'].includes(batch.status)) return batch;
    await wait(10);
  }
  throw new Error('批次未完成');
}

test('队列严格串行且单项失败不阻塞后续项', async () => {
  let active = 0;
  let maximum = 0;
  const executor = async (item) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await wait(20);
    active -= 1;
    if (item.name === 'fail.jpg') throw Object.assign(new Error('失败'), { code: 'TEST_FAIL' });
    return [{ goodsId: item.name }];
  };
  const service = new BatchService({ executor, runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'temu-batch-')) });
  const created = service.create([
    { name: 'one.jpg', localPath: 'one.jpg' },
    { name: 'fail.jpg', localPath: 'fail.jpg' },
    { name: 'three.jpg', localPath: 'three.jpg' },
  ]);
  const batch = await waitFinished(service, created.id);
  assert.equal(maximum, 1);
  assert.equal(batch.summary.succeeded, 2);
  assert.equal(batch.summary.failed, 1);
  assert.equal(batch.status, 'completed');
});

test('失败项可单独重试', async () => {
  let attempts = 0;
  const executor = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('首次失败');
    return Array.from({ length: 20 }, (_, index) => ({ goodsId: String(index) }));
  };
  const service = new BatchService({ executor, runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'temu-retry-')) });
  const created = service.create([{ name: 'retry.jpg', localPath: 'retry.jpg' }]);
  let batch = await waitFinished(service, created.id);
  assert.equal(batch.status, 'failed');
  service.retry(created.id, batch.items[0].id);
  batch = await waitFinished(service, created.id);
  assert.equal(batch.status, 'completed');
  assert.equal(batch.items[0].productCount, 20);
  assert.equal(batch.items[0].attempts, 2);
});

test('全部预置失败项会立即结束批次', () => {
  let executions = 0;
  const service = new BatchService({
    executor: async () => {
      executions += 1;
      return [];
    },
    runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'temu-prefailed-')),
  });
  const created = service.create([
    { name: 'bad-1', error: { code: 'IMAGE_DOWNLOAD_FAILED', message: '下载失败' } },
    { name: 'bad-2', error: { code: 'PRIVATE_URL', message: '禁止内网链接' } },
  ]);

  assert.equal(created.status, 'failed');
  assert.equal(created.summary.failed, 2);
  assert.ok(created.finishedAt);
  assert.equal(executions, 0);
});

test('部分预置失败项不阻塞其余任务', async () => {
  const executed = [];
  const service = new BatchService({
    executor: async (item) => {
      executed.push(item.name);
      return [{ goodsId: item.name }];
    },
    runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'temu-partial-')),
  });
  const created = service.create([
    { name: 'bad-url', error: { code: 'IMAGE_DOWNLOAD_FAILED', message: '下载失败' } },
    { name: 'good.jpg', localPath: 'good.jpg' },
  ]);
  const batch = await waitFinished(service, created.id);

  assert.deepEqual(executed, ['good.jpg']);
  assert.equal(batch.status, 'completed');
  assert.equal(batch.summary.failed, 1);
  assert.equal(batch.summary.succeeded, 1);
});

test('服务启动时恢复历史批次', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-restore-'));
  const batch = {
    id: 'history-batch',
    status: 'completed',
    createdAt: '2026-08-20T00:00:00.000Z',
    finishedAt: '2026-08-20T00:01:00.000Z',
    items: [{
      id: 'history-item',
      index: 0,
      name: 'history.jpg',
      source: 'history.jpg',
      localPath: 'history.jpg',
      status: 'succeeded',
      attempts: 1,
      products: [{ goodsId: '123' }],
      error: null,
    }],
  };
  fs.writeFileSync(path.join(runtimeDir, `${batch.id}.json`), JSON.stringify(batch));

  const service = new BatchService({ executor: async () => [], runtimeDir });
  const restored = service.get(batch.id, true);

  assert.equal(restored.status, 'completed');
  assert.equal(restored.items[0].products[0].goodsId, '123');
});

test('服务重启将运行中任务恢复为可重试失败项', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-interrupted-'));
  const batch = {
    id: 'interrupted-batch',
    status: 'running',
    createdAt: '2026-08-20T00:00:00.000Z',
    finishedAt: null,
    items: [{
      id: 'interrupted-item',
      index: 0,
      name: 'interrupted.jpg',
      source: 'interrupted.jpg',
      localPath: 'interrupted.jpg',
      status: 'running',
      attempts: 1,
      products: [],
      error: null,
    }],
  };
  fs.writeFileSync(path.join(runtimeDir, `${batch.id}.json`), JSON.stringify(batch));
  const service = new BatchService({
    executor: async () => [{ goodsId: 'recovered' }],
    runtimeDir,
  });

  let restored = service.get(batch.id, true);
  assert.equal(restored.status, 'interrupted');
  assert.equal(restored.items[0].status, 'failed');
  assert.equal(restored.items[0].error.code, 'SERVICE_RESTARTED');

  service.retry(batch.id, batch.items[0].id);
  restored = await waitFinished(service, batch.id);
  assert.equal(restored.status, 'completed');
  assert.equal(restored.items[0].products[0].goodsId, 'recovered');
});
