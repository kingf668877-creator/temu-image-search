const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../server');
const { BatchService } = require('../src/batch-service');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeService(executor) {
  return new BatchService({ executor, runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'temu-tasks-')) });
}

test('Temu 任务 API：上传只创建任务，需要显式触发搜索', async () => {
  let executed = 0;
  const executor = async () => {
    executed += 1;
    return [{ goodsId: 'g1', title: '商品1' }];
  };
  const app = createApp({ batches: makeService(executor), mode: 'mock' });

  const submitted = await request(app)
    .post('/api/temu/tasks/from-files')
    .attach('images', Buffer.from('fake'), { filename: 'demo.jpg', contentType: 'image/jpeg' })
    .expect(202);
  const taskId = submitted.body.task.id;
  assert.equal(submitted.body.task.status, 'created');
  assert.equal(executed, 0, '上传后不应立即执行');

  const idle = await request(app).get(`/api/temu/tasks/${taskId}`).expect(200);
  assert.equal(idle.body.task.status, 'created');
  assert.equal(idle.body.task.summary.queued, 1);

  const started = await request(app).post(`/api/temu/tasks/${taskId}/search`).expect(200);
  assert.ok(['queued', 'running'].includes(started.body.task.status));

  let snapshot;
  for (let i = 0; i < 50; i += 1) {
    snapshot = (await request(app).get(`/api/temu/tasks/${taskId}`).expect(200)).body.task;
    if (['completed', 'failed'].includes(snapshot.status)) break;
    await wait(10);
  }
  assert.equal(snapshot.status, 'completed');
  assert.equal(executed, 1);
  assert.equal(snapshot.summary.succeeded, 1);
});

test('Temu 任务 API：支持分页结果和 JSON/CSV 导出', async () => {
  const executor = async () => Array.from({ length: 25 }, (_, index) => ({ goodsId: `g${index}`, title: `商品${index}` }));
  const service = makeService(executor);
  const app = createApp({ batches: service, mode: 'mock' });

  const created = service.create(
    [{ name: 'demo.jpg', source: 'demo.jpg', previewUrl: null, localPath: 'demo.jpg' }],
    { autoStart: false }
  );
  const taskId = created.id;
  await request(app).post(`/api/temu/tasks/${taskId}/search`).expect(200);

  for (let i = 0; i < 50; i += 1) {
    const status = service.get(taskId, false).status;
    if (['completed', 'failed'].includes(status)) break;
    await wait(10);
  }

  const page = await request(app).get(`/api/temu/tasks/${taskId}/results?limit=10&offset=5`).expect(200);
  assert.equal(page.body.total, 25);
  assert.equal(page.body.products.length, 10);
  assert.equal(page.body.products[0].goodsId, 'g5');

  const csv = await request(app).get(`/api/temu/tasks/${taskId}/export?format=csv`).expect(200);
  assert.match(csv.text, /goodsId/);
  assert.match(csv.text, /g24/);

  const jsonExport = await request(app).get(`/api/temu/tasks/${taskId}/export?format=json`).expect(200);
  assert.equal(jsonExport.body.summary.succeeded, 1);
});

test('Temu 任务 API：取消和清理都会删除服务端结果', async () => {
  const executor = async () => [{ goodsId: 'doomed', title: '待清理' }];
  const app = createApp({ batches: makeService(executor), mode: 'mock' });

  const submitted = await request(app)
    .post('/api/temu/tasks/from-files')
    .attach('images', Buffer.from('fake'), { filename: 'doomed.jpg', contentType: 'image/jpeg' })
    .expect(202);
  const taskId = submitted.body.task.id;
  await request(app).post(`/api/temu/tasks/${taskId}/search`).expect(200);
  for (let i = 0; i < 50; i += 1) {
    const status = (await request(app).get(`/api/temu/tasks/${taskId}`).expect(200)).body.task.status;
    if (['completed', 'failed'].includes(status)) break;
    await wait(10);
  }

  await request(app).post(`/api/temu/tasks/${taskId}/cancel`).expect(200);
  await request(app).get(`/api/temu/tasks/${taskId}`).expect(404);
});

test('Temu 任务 API：列表按时间倒序返回', async () => {
  const executor = async () => [{ goodsId: 'x' }];
  const service = makeService(executor);
  service.batches.set('older', { id: 'older', status: 'completed', createdAt: '2026-08-20T00:00:00.000Z', finishedAt: null, items: [] });
  service.batches.set('newer', { id: 'newer', status: 'completed', createdAt: '2026-08-21T00:00:00.000Z', finishedAt: null, items: [] });
  const app = createApp({ batches: service, mode: 'mock' });

  const listed = await request(app).get('/api/temu/tasks').expect(200);
  assert.equal(listed.body.tasks[0].id, 'newer');
  assert.equal(listed.body.tasks[1].id, 'older');
});
