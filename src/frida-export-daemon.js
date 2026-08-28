// 长期运行的 Frida 导出守护进程：一次性附加到 Temu 主进程，加载一次导出脚本，
// 然后通过 TCP RPC（默认 127.0.0.1:27060）等待调用方触发导出，避免每次任务重新 attach。
//
// 调用方（executor）只需要向守护进程发送 {"action":"export","timeoutMs":60000}，
// 守护进程在收到请求后重新执行 Java.choose 读取最新的 BGProductListView。
const fs = require('fs');
const http = require('http');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const frida = require('frida');

const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.TEMU_FRIDA_DAEMON_HOST || '127.0.0.1';
const PORT = Number(process.env.TEMU_FRIDA_DAEMON_PORT || 27060);
const REMOTE = process.env.FRIDA_REMOTE || '127.0.0.1:27042';
const PACKAGE = 'com.einnovation.temu';
const AGENT_PATH = process.env.TEMU_EXPORT_AGENT || path.join(ROOT, 'scripts', 'temu-export-image-search-products-agent.js');

let compiledPath = null;
let device = null;
let session = null;
let script = null;
let busy = false;
let lastError = null;
let attachStartedAt = null;

function log(message) {
  const line = `[frida-daemon ${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(path.join(ROOT, 'runtime', 'diagnostics', 'frida-daemon.log'), line);
  } catch {}
}

async function compileAgent(agentPath) {
  const compiler = require.resolve('frida-compile/dist/cli.js');
  const compiled = path.join(ROOT, '.temu-export-daemon-agent.compiled.js');
  execFileSync(process.execPath, [compiler, agentPath, '-o', compiled], {
    cwd: path.dirname(agentPath),
    stdio: 'pipe',
  });
  return compiled;
}

function waitForIdle() {
  if (!script) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      script.message.disconnect(handler);
      resolve();
    }, 60000);
    const handler = (message) => {
      if (message.type !== 'send') return;
      const payload = message.payload || {};
      if (payload.tag === 'export-complete' || payload.tag === 'export-error') {
        clearTimeout(timer);
        script.message.disconnect(handler);
        resolve();
      }
    };
    script.message.connect(handler);
  });
}

async function ensureAttached() {
  if (session && !session.detached && script && !script.isDestroyed) return;
  attachStartedAt = Date.now();
  compiledPath = await compileAgent(AGENT_PATH);
  device = await frida.getDeviceManager().addRemoteDevice(REMOTE);
  const apps = await device.enumerateApplications({ scope: 'full' });
  const app = apps.find((item) => item.identifier === PACKAGE);
  if (!app || !app.pid) throw new Error('Temu 主进程未运行');
  session = await device.attach(app.pid);
  script = await session.createScript(fs.readFileSync(compiledPath, 'utf8'));
  // 等 agent 发出 agent-ready（说明 rpc.exports 已经完全赋值）。
  // 仅靠 result-hook-ready 会撞 race：hook 注册完先发 ready，但 rpc.exports 还没赋值，
  // 导致 script.exports 为空，后续 take_store_if_new 等 RPC 永远不返回。
  const ready = new Promise((resolve, reject) => {
    let resolved = false;
    let readyExports = null;
    const finish = (err) => {
      if (resolved) return;
      resolved = true;
      try { script.message.disconnect(handler); } catch {}
      if (err) reject(err); else resolve(readyExports);
    };
    const handler = (message) => {
      if (message.type !== 'send') return;
      const payload = message.payload || {};
      log(`agent ${payload.tag}: ${payload.message || JSON.stringify(payload).slice(0, 200)}`);
      if (payload.tag === 'agent-ready') {
        readyExports = payload.exports || null;
        return finish();
      }
    };
    script.message.connect(handler);
    setTimeout(() => finish(new Error('attach 后 agent 初始化超时（20s）')), 20000);
  });
  await script.load();
  log(`attached to pid=${app.pid}, waiting for agent-ready`);
  const readyExports = await ready;
  // 注意：script.exports 是 ScriptExportsProxy（Proxy 对象），
  // Object.keys 看不到代理的真实键，但属性访问会通过 get trap 返回一个真正的 RPC 函数。
  // 真正可用的导出名由 agent 在 agent-ready payload 里给出。
  log(`agent ready, declared_exports=${(readyExports || []).join(',')}`);
}

async function detach() {
  try { await script && script.unload(); } catch {}
  try { await session && session.detach(); } catch {}
  script = null;
  session = null;
}

function productSignature(products = []) {
  return products.map((product) => String(
    product && (product.goods_id || product.goodsId || product.goods_id_str || product.id) || ''
  )).filter(Boolean).join('|');
}

async function captureBaseline() {
  try {
    const current = await runExport(5000);
    return productSignature(current.products);
  } catch {
    return '';
  }
}

function goodsId(product) {
  if (!product || typeof product !== 'object') return null;
  return product.goods_id || product.goodsId || product.goods_id_str || product.goodsIdStr || product.id || null;
}

function findProductArray(value, depth = 0) {
  if (!value || depth > 12) return null;
  if (Array.isArray(value)) {
    const objects = value.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    const withIds = objects.filter((item) => goodsId(item));
    if (withIds.length >= 3 && withIds.length >= Math.ceil(objects.length * 0.5)) return withIds;
    for (const item of value) {
      const nested = findProductArray(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value === 'object') {
    const preferred = ['goods_list', 'goodsList', 'items', 'products', 'result', 'data'];
    const keys = [...preferred.filter((key) => key in value), ...Object.keys(value).filter((key) => !preferred.includes(key))];
    for (const key of keys) {
      const nested = findProductArray(value[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function productsFromResponses(responses) {
  for (const response of responses || []) {
    try {
      const parsed = JSON.parse(response.body);
      const products = findProductArray(parsed);
      if (products && products.length) return { products, responseUrl: response.url, capturedAt: response.capturedAt };
    } catch {}
  }
  return null;
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitForResponseProducts(taskId, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + (timeoutMs || 90000);
  let parsedResponses = 0;
  let loops = 0;
  log(`/wait-export start taskId=${taskId} timeoutMs=${timeoutMs} pollMs=${pollIntervalMs}`);
  while (Date.now() < deadline) {
    loops += 1;
    // 任意单次 RPC 最多占用 2 秒，保证总超时与队列释放可预测。
    const remaining = Math.max(1, deadline - Date.now());
    const rpcTimeout = Math.min(2000, remaining);
    let storeCapture;
    try {
      storeCapture = await withTimeout(
        Promise.resolve(script.exports.take_store_if_new(taskId)),
        rpcTimeout,
        `商品仓库快照调用超时（${rpcTimeout}ms）`
      );
    } catch (rpcErr) {
      log(`/wait-export loop=${loops} take_store_if_new threw: ${rpcErr && rpcErr.message}`);
      throw rpcErr;
    }
    if (storeCapture && storeCapture.products && storeCapture.products.length) {
      log(`/wait-export loop=${loops} got products=${storeCapture.products.length} signature=${storeCapture.signature}`);
      await script.exports.clear_http(taskId).catch(() => {});
      return { ...storeCapture, parsedResponses };
    }
    // 不再调用 take_http：HTTP 拦截链本身会被 Temu 的全堆扫描阻塞，与 take_store_if_new
    // 共用同一 V8 线程，一次 hang 会让整轮 RPC 全部卡死。
    // 失败诊断时仍然由 http_stats RPC 主动采样一次，避免在主循环里轮询。
    if (loops <= 3 || loops % 10 === 0) {
      log(`/wait-export loop=${loops} no products yet remainingMs=${Math.round(remaining)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs || 250));
  }
  const stats = await script.exports.http_stats(taskId).catch(() => null);
  await script.exports.clear_http(taskId).catch(() => {});
  const error = new Error(`等待本次图搜响应反序列化商品超时（${timeoutMs || 90000}ms）`);
  error.code = 'RESPONSE_PRODUCT_WAIT_TIMEOUT';
  error.httpStats = stats;
  error.parsedResponses = parsedResponses;
  throw error;
}

async function waitForNewProducts(baseline, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + (timeoutMs || 90000);

  while (Date.now() < deadline) {
    try {
      const result = await runExport(Math.min(5000, Math.max(1000, deadline - Date.now())));
      const signature = productSignature(result.products);
      if (result.products.length > 0 && (!baseline || signature !== baseline)) {
        return { ...result, baseline, signature };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs || 500));
  }
  const error = new Error(`等待本次图搜商品超时（${timeoutMs || 90000}ms）`);
  error.code = 'PRODUCT_WAIT_TIMEOUT';
  throw error;
}

async function runExport(timeoutMs) {
  if (busy) {
    const error = new Error('守护进程正在处理另一个请求');
    error.code = 'DAEMON_BUSY';
    throw error;
  }
  busy = true;
  try {
    await ensureAttached();
    let meta = null;
    const products = [];
    let exportError = null;
    let completed = false;
    const handler = (message) => {
      if (message.type === 'error') {
        exportError = message.stack || message.description || 'script error';
        completed = true;
        return;
      }
      if (message.type !== 'send') return;
      const payload = message.payload || {};
      if (payload.tag === 'export-start') meta = payload;
      if (payload.tag === 'export-product') products[payload.index] = payload.product;
      if (payload.tag === 'export-error') {
        exportError = payload.error || 'export error';
        completed = true;
      }
      if (payload.tag === 'export-complete') completed = true;
      if (payload.tag === 'agent-log' || payload.tag === 'result-hook-ready' || payload.tag === 'result-hook-missing' || payload.tag === 'live-snapshot') {
        log(`agent ${payload.tag}: ${payload.message || JSON.stringify(payload).slice(0, 200)}`);
      }
    };
    script.message.connect(handler);
    try {
      // frida 17 node binding：script.exports 本身就是 RpcExports 代理
      await script.exports.run_export();
      const deadline = Date.now() + (timeoutMs || 60000);
      while (!completed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!completed) throw new Error(`商品导出超时（${timeoutMs || 60000}ms）`);
    } finally {
      script.message.disconnect(handler);
    }
    if (exportError) throw new Error(exportError);
    return { meta, products };
  } finally {
    busy = false;
  }
}

const baselines = new Map();

const server = http.createServer(async (req, res) => {
  if ((req.method === 'GET' || req.method === 'POST') && req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      busy,
      attached: Boolean(session && !session.detached),
      attach_age_ms: attachStartedAt ? Date.now() - attachStartedAt : null,
      last_error: lastError,
    }));
    return;
  }
  const supportedPaths = ['/export', '/baseline', '/wait-export'];
  if (req.method !== 'POST' || !supportedPaths.includes(req.url)) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 8192) req.destroy(); });
  req.on('end', async () => {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }
    const timeoutMs = Number(payload.timeoutMs || 60000);
    log(`request ${req.method} ${req.url} payload=${JSON.stringify(payload).slice(0, 200)}`);
    try {
      let result;
      if (req.url === '/baseline') {
        const taskId = String(payload.taskId || 'default');
        // 纯 HTTP 方案只需要点击前完成 attach 和响应监听注册，不能再扫描页面或内存仓库。
        await ensureAttached();
        // arm_http 本身是同步返回 + 后台 discoverStores，但 RPC 链路本身仍可能 hang，
        // 给个 5s 兜底。discoverStores 的 Java.choose 由 agent 在后台跑，与 RPC 返回解耦。
        await withTimeout(
          Promise.resolve(script.exports.arm_http(taskId)),
          Math.min(5000, timeoutMs || 5000),
          'arm_http 调用超时'
        );
        baselines.set(taskId, '');
        result = { taskId, baseline: '', armed: true, httpArmed: true, attached: true };
      } else if (req.url === '/wait-export') {
        const taskId = String(payload.taskId || 'default');
        try {
          result = await waitForResponseProducts(taskId, timeoutMs, Number(payload.pollIntervalMs || 250));
          result.source = 'response-deserialized-store';
        } catch (responseError) {
          const error = new Error(String(responseError.message || responseError));
          error.code = responseError.code || 'RESPONSE_PRODUCT_WAIT_TIMEOUT';
          error.source = 'response-deserialized-store';
          error.httpStats = responseError.httpStats || null;
          error.parsedResponses = responseError.parsedResponses || 0;
          throw error;
        }
        baselines.delete(taskId);
      } else if (req.url === '/snapshot-stores') {
        // 暴露给 executor 的轻量探针：返回已知仓库的最新商品快照，避免在主流程里再次 Java.choose。
        try {
          const snapshot = await withTimeout(
            script.exports.snapshot_known_stores(),
            Math.min(5000, timeoutMs || 5000),
            'snapshot-stores 调用超时'
          );
          result = { products: (snapshot && snapshot.products) || [], source: 'response-deserialized-store' };
        } catch (snapshotError) {
          result = { products: [], source: 'response-deserialized-store', error: String(snapshotError.message || snapshotError) };
        }
      } else {
        result = await runExport(timeoutMs);
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      const errMsg = String(error && error.message || error);
      const errorPayload = {
        ok: false,
        code: error && error.code || 'DAEMON_REQUEST_FAILED',
        error: errMsg,
        source: error && error.source || null,
        httpStats: error && error.httpStats || null,
        parsedResponses: error && error.parsedResponses || 0,
      };
      // daemon busy：让客户端排队重试，不要重置 session
      if (error && error.code === 'DAEMON_BUSY') {
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(errorPayload));
        return;
      }
      lastError = errMsg;
      log(`export failed: ${errMsg}\n${error && error.stack || ''}`);
      // 一次失败就重置 session，避免下次再进入异常状态
      await detach().catch(() => {});
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(errorPayload));
    }
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 已被占用，将通过 ENV TEMU_FRIDA_DAEMON_PORT 选择其他端口`);
    process.exit(2);
  }
  throw error;
});

process.on('SIGINT', async () => {
  log('收到 SIGINT，正在关闭');
  await detach().catch(() => {});
  server.close(() => process.exit(0));
});
process.on('SIGTERM', async () => {
  log('收到 SIGTERM，正在关闭');
  await detach().catch(() => {});
  server.close(() => process.exit(0));
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    log(`listening on http://${HOST}:${PORT} (frida remote=${REMOTE})`);
  });
}

module.exports = { runExport, ensureAttached, detach, findProductArray, productsFromResponses, server };