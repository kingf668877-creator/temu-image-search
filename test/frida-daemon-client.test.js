const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function startMockDaemon(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function loadClient(port) {
  const modulePath = require.resolve('../src/frida-daemon-client');
  delete require.cache[modulePath];
  process.env.TEMU_FRIDA_DAEMON_HOST = '127.0.0.1';
  process.env.TEMU_FRIDA_DAEMON_PORT = String(port);
  return require(modulePath);
}

test('exportProducts 将 daemon 返回的商品 JSON 透传', async () => {
  const products = [{ goodsId: 'p1', title: 'mock' }];
  const { server, port } = await startMockDaemon((req, res, body) => {
    assert.equal(req.url, '/export');
    assert.equal(req.method, 'POST');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, products }));
  });
  try {
    const client = loadClient(port);
    const result = await client.exportProducts({ timeoutMs: 5000 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.products, products);
  } finally {
    server.close();
  }
});

test('exportProducts 在 daemon 失败时抛出 DAEMON_REQUEST_FAILED', async () => {
  const { server, port } = await startMockDaemon((req, res) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, code: 'DAEMON_REQUEST_FAILED', error: '导出失败' }));
  });
  try {
    const client = loadClient(port);
    await assert.rejects(client.exportProducts({ timeoutMs: 5000 }), /导出失败/);
  } finally {
    server.close();
  }
});

test('exportProducts 在 daemon busy 时自动排队重试直到拿到结果', async () => {
  let attempts = 0;
  const { server, port } = await startMockDaemon((req, res) => {
    attempts += 1;
    if (attempts < 3) {
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, code: 'DAEMON_BUSY', error: '守护进程正在处理另一个请求' }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, products: [{ goodsId: 'late' }] }));
  });
  try {
    const client = loadClient(port);
    process.env.TEMU_FRIDA_DAEMON_BUSY_RETRY_MS = '20';
    process.env.TEMU_FRIDA_DAEMON_BUSY_MAX_WAIT_MS = '5000';
    const result = await client.exportProducts({ timeoutMs: 5000 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.products, [{ goodsId: 'late' }]);
    assert.equal(attempts, 3);
  } finally {
    server.close();
  }
});

test('exportProducts 在 daemon busy 持续超过 busyMaxWaitMs 时抛错', async () => {
  const { server, port } = await startMockDaemon((req, res) => {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, code: 'DAEMON_BUSY', error: 'busy' }));
  });
  try {
    const client = loadClient(port);
    process.env.TEMU_FRIDA_DAEMON_BUSY_RETRY_MS = '20';
    await assert.rejects(
      client.exportProducts({ timeoutMs: 5000, busyMaxWaitMs: 100 }),
      /busy|处理另一个请求/,
    );
  } finally {
    server.close();
  }
});

test('ensureDaemon 在 health 不通时调用 spawn 拉起并重试', async () => {
  // 第一阶段：/health 失败 -> 触发 spawn；spawn 执行后端口监听成功。
  // 第二阶段：随后 5 秒内 /health 应返回 ok，ensureDaemon 完成。
  const initialResponse = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); }
      else { res.statusCode = 404; res.end(); }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
  let spawnCalls = 0;
  const client = loadClient(initialResponse.port);
  await client.ensureDaemon({
    spawn: () => new Promise((resolve) => {
      spawnCalls += 1;
      setTimeout(resolve, 50);
    }),
  });
  assert.equal(spawnCalls, 0, 'daemon 已经在监听时不应再次拉起');
  await new Promise((r) => setTimeout(r, 50));
  initialResponse.server.close();
});

test('ensureDaemon 在 daemon 完全不存在时调用 spawn', async () => {
  const client = loadClient(1); // 端口 1 一般没有监听
  let spawnCalled = false;
  // 用一个伪 daemon 在 ensureDaemon 重试前就启动
  let startedServer = null;
  const spawnPromise = new Promise((resolve) => {
    startedServer = http.createServer((req, res) => {
      if (req.url === '/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); }
      else { res.statusCode = 404; res.end(); }
    });
    setTimeout(() => startedServer.listen(0, '127.0.0.1', resolve), 50);
  });
  // 不等待，让 client 自己轮询
  await spawnPromise;
  // 重新加载 client 指向新端口
  process.env.TEMU_FRIDA_DAEMON_PORT = String(startedServer.address().port);
  const newClient = loadClient(startedServer.address().port);
  await newClient.ensureDaemon({
    spawn: () => new Promise((resolve) => { spawnCalled = true; resolve(); }),
  });
  // 这里其实端口已经监听了，spawn 不会再触发
  assert.equal(spawnCalled, false);
  startedServer.close();
});

test('captureBaseline 直接走 /baseline 并使用调用方超时', async () => {
  let observedTimeoutMs = null;
  const { server, port } = await startMockDaemon((req, res, body) => {
    if (req.url === '/baseline') {
      const parsed = JSON.parse(body || '{}');
      observedTimeoutMs = parsed.timeoutMs;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, baseline: '', armed: true }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  try {
    const client = loadClient(port);
    const result = await client.captureBaseline({ taskId: 'alpha', timeoutMs: 4321 });
    assert.equal(result.ok, true);
    assert.equal(result.armed, true);
    assert.equal(observedTimeoutMs, 4321);
  } finally {
    server.close();
  }
});

test('snapshotStores 把 daemon 返回的商品透传', async () => {
  const products = [{ goodsId: 'p1', title: 'snapshot' }];
  const { server, port } = await startMockDaemon((req, res) => {
    if (req.url === '/snapshot-stores') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, products, source: 'response-deserialized-store' }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  try {
    const client = loadClient(port);
    const result = await client.snapshotStores({ taskId: 's1', timeoutMs: 2000 });
    assert.equal(result.source, 'response-deserialized-store');
    assert.deepEqual(result.products, products);
  } finally {
    server.close();
  }
});