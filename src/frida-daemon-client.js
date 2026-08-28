// 简易 HTTP 客户端：向 frida-export-daemon.js 发起 export 请求。
// daemon 启动一次后保持 attach，所有 export 调用复用同一个会话。
// daemon 端有 `busy` flag，被占时返回 503 + BUSY 错误；本客户端会做排队重试。
const http = require('http');

const HOST = process.env.TEMU_FRIDA_DAEMON_HOST || '127.0.0.1';
const PORT = Number(process.env.TEMU_FRIDA_DAEMON_PORT || 27060);
const REQUEST_TIMEOUT_MS = Number(process.env.TEMU_FRIDA_DAEMON_REQUEST_TIMEOUT_MS || 90000);
const BUSY_RETRY_INTERVAL_MS = Number(process.env.TEMU_FRIDA_DAEMON_BUSY_RETRY_MS || 1500);
const BUSY_MAX_WAIT_MS = Number(process.env.TEMU_FRIDA_DAEMON_BUSY_MAX_WAIT_MS || 120000);

function requestOnce(path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: HOST,
      port: PORT,
      method: 'POST',
      path,
      headers: {
        'content-type': 'application/json',
        ...(payload ? { 'content-length': payload.length } : {}),
      },
      timeout: timeoutMs || REQUEST_TIMEOUT_MS,
    }, (response) => {
      let chunks = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { chunks += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : {}; } catch {}
        // 503 表示 daemon busy；不当作硬错误，让上层排队重试
        if (response.statusCode === 503 && parsed && parsed.code === 'DAEMON_BUSY') {
          const error = new Error(parsed.error || 'Frida daemon is busy');
          error.code = 'DAEMON_BUSY';
          error.statusCode = 503;
          return reject(error);
        }
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(parsed);
        const error = new Error(parsed && parsed.error || `HTTP ${response.statusCode}`);
        error.code = parsed && parsed.code || 'DAEMON_REQUEST_FAILED';
        error.statusCode = response.statusCode;
        if (parsed && typeof parsed === 'object') {
          Object.assign(error, parsed);
        }
        reject(error);
      });
    });
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('Frida daemon request timeout'), { code: 'DAEMON_TIMEOUT' }));
    });
    req.on('error', (error) => reject(error));
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureDaemon({ spawn } = {}) {
  // 探测一次健康检查，如果 daemon 没起就尝试拉起
  let alive = false;
  try {
    await requestOnce('/health', null, 1500).then((r) => { alive = !!(r && r.ok); }).catch(() => {});
  } catch {}
  if (alive) return;
  if (typeof spawn !== 'function') {
    const error = new Error('Frida daemon 未运行且未提供 spawn 回调');
    error.code = 'DAEMON_NOT_RUNNING';
    throw error;
  }
  await spawn();
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const ok = await requestOnce('/health', null, 1500).then((r) => !!(r && r.ok)).catch(() => false);
      if (ok) return;
    } catch {}
  }
  const error = new Error('Frida daemon 启动超时');
  error.code = 'DAEMON_NOT_RUNNING';
  throw error;
}

// 失败自动排队重试：daemon busy 时按 BUSY_RETRY_INTERVAL_MS 轮询，
// 累计等待超过 BUSY_MAX_WAIT_MS 抛错。
async function exportProducts(options = {}) {
  const deadline = Date.now() + (options.busyMaxWaitMs || BUSY_MAX_WAIT_MS);
  const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
  while (true) {
    try {
      return await requestOnce('/export', { timeoutMs }, timeoutMs);
    } catch (error) {
      if (error && error.code === 'DAEMON_BUSY' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, BUSY_RETRY_INTERVAL_MS));
        continue;
      }
      throw error;
    }
  }
}

async function captureBaseline(options = {}) {
  // /baseline 只做 attach + 注册 arm，不再扫描商品仓库；10s 已绰绰有余。
  // 同时把 timeoutMs 透传给 daemon，方便端到端日志记录与可能的内部 RPC 预算。
  return requestOnce('/baseline', {
    taskId: options.taskId || 'default',
    timeoutMs: options.timeoutMs || 10000,
  }, options.timeoutMs || 10000);
}

async function snapshotStores(options = {}) {
  return requestOnce('/snapshot-stores', { taskId: options.taskId || 'default' }, options.timeoutMs || 5000);
}

async function waitForProducts(options = {}) {
  const timeoutMs = options.timeoutMs || 90000;
  return requestOnce('/wait-export', {
    taskId: options.taskId || 'default',
    timeoutMs,
    pollIntervalMs: options.pollIntervalMs || 500,
  }, timeoutMs + 5000);
}

module.exports = { exportProducts, captureBaseline, waitForProducts, snapshotStores, ensureDaemon, requestOnce };