const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { createApp, isPrivateAddress } = require('../server');
const { BatchService } = require('../src/batch-service');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('健康检查和文件批次 API 返回分组商品', async () => {
  const executor = async () => Array.from({ length: 20 }, (_, index) => ({ goodsId: String(index), title: `商品${index}` }));
  const batches = new BatchService({ executor, runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'temu-api-')) });
  const app = createApp({ batches, mode: 'mock' });
  const health = await request(app).get('/api/health').expect(200);
  assert.equal(health.body.ok, true);
  const submitted = await request(app).post('/api/batches/files').attach('images', Buffer.from('fake'), { filename: 'demo.jpg', contentType: 'image/jpeg' }).expect(202);
  const batchId = submitted.body.batch.id;
  let batch;
  for (let i = 0; i < 50; i += 1) {
    batch = (await request(app).get(`/api/batches/${batchId}`).expect(200)).body.batch;
    if (batch.status === 'completed') break;
    await wait(10);
  }
  assert.equal(batch.items[0].products.length, 20);
  const csv = await request(app).get(`/api/batches/${batchId}/export?format=csv`).expect(200);
  assert.match(csv.text, /goodsId/);
});

test('停止和删除批次 API 会清理服务端结果', async () => {
  const executor = async () => [{ goodsId: 'clean-me', title: '待清理商品' }];
  const batches = new BatchService({ executor, runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'temu-api-clean-')) });
  const app = createApp({ batches, mode: 'mock' });
  const submitted = await request(app).post('/api/batches/files').attach('images', Buffer.from('fake'), { filename: 'clean.jpg', contentType: 'image/jpeg' }).expect(202);
  const batchId = submitted.body.batch.id;
  for (let i = 0; i < 50; i += 1) {
    const batch = batches.get(batchId, true);
    if (batch && ['completed', 'failed'].includes(batch.status)) break;
    await wait(10);
  }

  await request(app).post(`/api/batches/${batchId}/cleanup`).expect(200);
  await request(app).get(`/api/batches/${batchId}`).expect(404);
});

test('识别回环和私网地址', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('192.168.1.8'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});
