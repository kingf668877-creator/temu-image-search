// 集成测试：启动一个伪 daemon，触发 realExecute() 中的 daemon 路径，
// 验证 executor 在 TEMU_USE_FRIDA_DAEMON=1 时会调用 daemon 而不是 spawn host。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function startFakeDaemon(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function reloadExecutors(envOverrides) {
  Object.entries(envOverrides).forEach(([k, v]) => { process.env[k] = v; });
  const modulePath = require.resolve('../src/executors');
  delete require.cache[modulePath];
  // executor 也通过 daemonClient 读取端口
  const clientPath = require.resolve('../src/frida-daemon-client');
  delete require.cache[clientPath];
  return require(modulePath);
}

test('realExecute 走 daemon 路径并使用 daemon 返回的商品', async () => {
  // 1. 启动伪 daemon
  let exportCalls = 0;
  const { server, port } = await startFakeDaemon((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/baseline') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, baseline: '', httpArmed: true }));
      return;
    }
    if (req.url === '/wait-export' || req.url === '/export') {
      exportCalls += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        source: req.url === '/wait-export' ? 'http-response' : 'memory-export',
        responseUrl: req.url === '/wait-export' ? 'https://api.example.invalid/image-search' : null,
        meta: { tag: 'export-start' },
        products: [
          {
            _class: 'com.baogong.app_base_entity.h',
            goods_id: 'g1',
            title: 'daemon-product',
            image: { url: 'https://x/1.jpg' },
            sales_num: 12,
            sales_tip: '12 sold',
            link_url: 'https://www.temu.com/goods.html?goods_id=g1',
            price_info: { price: '100', price_str: '$1.00', currency: 'USD' },
            p_search: { _json: '{"scene":"image_search_result"}' },
          },
        ],
      }));
      return;
    }
    res.statusCode = 404; res.end();
  });

  try {
    // 2. 准备一张“假图片”让 IMAGE_NOT_FOUND 校验通过
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temu-exec-daemon-'));
    // 集成测试不触及真实设备，跳过监听准备阶段中的 ADB 启动。
    const imagePath = path.join(tmpDir, 'fake.jpg');
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    // 3. 屏蔽 search script：用 stub 替代（不让它去 ADB）
    const searchStub = path.join(tmpDir, 'search-stub.js');
    fs.writeFileSync(searchStub, 'console.log("search stub ok");');

    const { realExecute } = reloadExecutors({
      TEMU_USE_FRIDA_DAEMON: '1',
      TEMU_FRIDA_DAEMON_PORT: String(port),
      TEMU_SEARCH_SCRIPT: searchStub,
      TEMU_TEST_SKIP_DEVICE_PREPARE: '1',
      TEMU_EXPORT_TIMEOUT_MS: '5000',
      TEMU_SEARCH_TIMEOUT_MS: '5000',
    });

    // 4. 由于真实搜索脚本被 stub 替换，会走 daemon 路径
    const products = await realExecute({ id: 'item-1', localPath: imagePath }, () => {});
    assert.ok(Array.isArray(products));
    assert.equal(products.length, 1);
    assert.equal(products[0].goodsId, 'g1');
    assert.equal(exportCalls, 1);
  } finally {
    server.close();
  }
});