const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { normalizeProduct } = require('./product-normalizer');
const daemonClient = require('./frida-daemon-client');
const { AdbClient } = require('../scripts/AdbClient');

const ROOT = path.resolve(__dirname, '..');
const SEARCH_SCRIPT = process.env.TEMU_SEARCH_SCRIPT || path.join(ROOT, 'scripts', 'temu-single-image-search-report.js');
const EXPORT_HOST = process.env.TEMU_EXPORT_HOST || path.join(__dirname, 'frida-export-host.js');
const DAEMON_HOST = process.env.TEMU_FRIDA_DAEMON_HOST || path.join(__dirname, 'frida-export-daemon.js');
const AGENT_PATH = process.env.TEMU_EXPORT_AGENT || path.join(ROOT, 'scripts', 'temu-export-image-search-products-agent.js');
const BACK_TO_HOME_SCRIPT = path.join(ROOT, 'scripts', 'temu-back-to-home.js');
// 选图触发是一个独立阶段，不能与后续商品监听共用三分钟总预算。
// 默认 75 秒：足够覆盖启动、相册刷新和一次选择器操作，也能保证失败图片及时释放队列。
const SEARCH_TIMEOUT_MS = Number(process.env.TEMU_SEARCH_TIMEOUT_MS || 360000);
// 选图触发阶段：默认 55s。脚本内部 TRIGGER_BUDGET 默认 50s。
// 外层 runNode 比脚本预算多 5s，强制保险，避免 SIGKILL 抢在脚本写报告之前。
const SEARCH_TRIGGER_TIMEOUT_MS = Number(process.env.TEMU_SEARCH_TRIGGER_TIMEOUT_MS || 55000);
const USE_FRIDA_DAEMON = process.env.TEMU_USE_FRIDA_DAEMON !== '0';

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = 'EXECUTOR_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function runNode(script, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const killChild = (force) => {
      if (killed) return;
      killed = true;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), force ? '/t /f' : '/t'], { windowsHide: true });
      } else {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      }
    };
    const timer = setTimeout(() => {
      // 第一次超时：先发温和信号，让脚本里的 ensureBudgetOrExit 有机会
      // 写完诊断报告再 process.exit(2)；3 秒后仍未关闭再强制结束进程树。
      killChild(false);
      const forceTimer = setTimeout(() => killChild(true), 3000);
      forceTimer.unref && forceTimer.unref();
      // 等到子进程真正关闭或外层兜底 8 秒后才算超时
      const finalTimer = setTimeout(() => {
        const error = new Error(`步骤超时：${path.basename(script)}`);
        error.code = 'EXECUTOR_TIMEOUT';
        reject(error);
      }, 8000);
      finalTimer.unref && finalTimer.unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        const error = new Error(`步骤超时：${path.basename(script)}`);
        error.code = 'EXECUTOR_TIMEOUT';
        reject(error);
        return;
      }
      if (code !== 0 && code !== 2) {
        const error = new Error((stderr || stdout || `退出码 ${code}`).trim());
        error.code = 'DEVICE_STEP_FAILED';
        reject(error);
      } else {
        // code === 0 正常返回；code === 2 表示脚本在 SKIP_RESULT_WAIT 模式下
        // 写完报告后主动让出，外层 export 阶段仍可继续等待 daemon 商品监听。
        // 报告 JSON 已落盘，外层仍可通过 runNode 返回值或 report.json 拿到诊断。
        resolve(code === 2 ? '' : stdout.trim());
      }
    });
  });
}

function mockProducts(seed) {
  return Array.from({ length: 20 }, (_, index) => ({
    goodsId: `${seed.replace(/\D/g, '').slice(-6) || '607384'}${String(index).padStart(3, '0')}`,
    skuId: `SKU-${index + 1}`,
    mallId: `MALL-${(index % 4) + 1}`,
    title: `Temu 图搜示例商品 ${index + 1} · 与源图片相似的商品`,
    imageUrl: `https://picsum.photos/seed/temu-${seed}-${index}/600/600`,
    price: Number((7.5 + index * 0.63).toFixed(2)),
    priceText: `$${(7.5 + index * 0.63).toFixed(2)}`,
    currency: 'USD',
    marketPrice: Number((12 + index * 0.8).toFixed(2)),
    marketPriceText: `$${(12 + index * 0.8).toFixed(2)}`,
    discountText: index % 3 === 0 ? '-36%' : null,
    sales: index * 23 + 7,
    salesText: `${index * 23 + 7} sold`,
    productUrl: `https://www.temu.com/goods.html?goods_id=mock-${index}`,
    isAd: index % 5 === 0,
    tags: index % 5 === 0 ? ['AD'] : [],
    position: index,
    searchId: `mock-${seed}`,
    scene: 'image_search_result',
    imageSearchVerified: true,
  }));
}

async function mockExecute(item, onProgress = () => {}) {
  onProgress('preparing');
  await new Promise((resolve) => setTimeout(resolve, 80));
  onProgress('searching');
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (/fail/i.test(item.name || item.source || '')) {
    const error = new Error('模拟图片搜索失败');
    error.code = 'MOCK_SEARCH_FAILED';
    throw error;
  }
  onProgress('extracting');
  await new Promise((resolve) => setTimeout(resolve, 80));
  return mockProducts(item.id);
}

async function ensureExportDaemon() {
  const ensure = () => daemonClient.ensureDaemon({
    spawn: () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [DAEMON_HOST], {
        cwd: ROOT,
        env: {
          ...process.env,
          TEMU_FRIDA_DAEMON_HOST: process.env.TEMU_FRIDA_DAEMON_HOST || '127.0.0.1',
          TEMU_FRIDA_DAEMON_PORT: process.env.TEMU_FRIDA_DAEMON_PORT || '27060',
          TEMU_EXPORT_AGENT: AGENT_PATH,
          FRIDA_REMOTE: process.env.FRIDA_REMOTE || '127.0.0.1:27042',
        },
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      child.on('error', reject);
      // 守护进程是 detached 的，主进程不能等它退出
      setTimeout(resolve, 200);
    }),
  });
  await ensure();
}

async function realExecute(item, onProgress = () => {}) {
  if (!item.localPath || !fs.existsSync(item.localPath)) {
    const error = new Error('待搜索图片不存在');
    error.code = 'IMAGE_NOT_FOUND';
    throw error;
  }
  onProgress('preparing');
  onProgress('searching');
  // 连跑模式：默认走 fast_ready (TEMU_FAST_MODE=2)。通过 TEMU_FORCE_COLD_START=1 可强制冷启动。
  const fastMode = process.env.TEMU_FORCE_COLD_START === '1' ? '0' : '2';
  // fast_precise 默认开启：减少 dump 重试次数（半天方案 C 优化）
  const fastPrecise = process.env.TEMU_FORCE_PRECISE_DUMP === '1' ? '0' : '1';
  const taskToken = `${item.id}-attempt-${item.attempts || 1}`;
  const exportTimeoutMs = Number(process.env.TEMU_EXPORT_TIMEOUT_MS || 90000);
  let listenerReady = false;
  if (USE_FRIDA_DAEMON) {
    try {
      // 监听必须早于选图点击：准备阶段也设硬上限，不能让 ADB / Frida 初始化无限卡住任务。
      await withTimeout((async () => {
        if (process.env.TEMU_TEST_SKIP_DEVICE_PREPARE !== '1') {
          const adb = new AdbClient();
          await adb.startApp('com.einnovation.temu');
        }
        await ensureExportDaemon();
        // arm 阶段已经取消 Java.choose，但仍需预留 Temu 启动早期 attach 的耗时。
        await daemonClient.captureBaseline({ taskId: taskToken, timeoutMs: 15000 });
      })(), 45000, '图搜监听准备超时（45000ms）');
      listenerReady = true;
    } catch (error) {
      item.listenerError = String(error && error.message || error);
      item.listenerErrorCode = error && error.code || 'LISTENER_PREPARE_FAILED';
      // 监听模式下不能无监听继续点图，否则会重新回到结果页等待路径且没有可用取数结果。
      throw error;
    }
  }
  try {
    await runNode(SEARCH_SCRIPT, {
      TEMU_IMAGE: item.localPath,
      TEMU_TASK_ID: taskToken,
      TEMU_FAST_MODE: fastMode,
      TEMU_FAST_PRECISE: fastPrecise,
      TEMU_SKIP_RESULT_WAIT: listenerReady ? '1' : '0',
      // 把脚本内部预算显式传给子进程：默认 50s，比 runNode 超时短 5s，
      // 让脚本先主动写报告再 throw。
      TEMU_TRIGGER_BUDGET_MS: String(Math.max(5000, SEARCH_TRIGGER_TIMEOUT_MS - 5000)),
    }, Math.min(SEARCH_TIMEOUT_MS, SEARCH_TRIGGER_TIMEOUT_MS));
  } catch (error) {
    // runNode 会结束完整子进程树；记录触发阶段，便于前端区分“未点到图”与“商品未返回”。
    item.triggerError = String(error && error.message || error);
    item.triggerErrorCode = error && error.code || 'IMAGE_TRIGGER_FAILED';
    throw error;
  }
  onProgress('extracting');
  let products = [];
  let usedDaemon = false;
  if (listenerReady) {
    try {
      const result = await daemonClient.waitForProducts({ taskId: taskToken, timeoutMs: exportTimeoutMs, pollIntervalMs: 250 });
      item.exportSource = result.source || 'daemon';
      item.responseUrl = result.responseUrl || null;
      item.responseCapturedAt = result.capturedAt || null;
      products = (result.products || []).map(normalizeProduct);
      usedDaemon = true;
    } catch (error) {
      item.exportSource = 'http-response-failed';
      item.httpCaptureError = String(error && error.message || error);
      item.httpStats = error && error.httpStats || null;
      item.parsedResponses = error && error.parsedResponses || 0;
      throw error;
    }
  } else if (USE_FRIDA_DAEMON) {
    try {
      await ensureExportDaemon();
      const result = await daemonClient.exportProducts({ timeoutMs: exportTimeoutMs });
      products = (result.products || []).map(normalizeProduct);
      usedDaemon = true;
    } catch (error) {
      const output = path.join(path.dirname(item.localPath), `${item.id}-products.json`);
      await runNode(EXPORT_HOST, { TEMU_EXPORT_AGENT: AGENT_PATH, TEMU_EXPORT_OUTPUT: output }, exportTimeoutMs);
      const payload = JSON.parse(fs.readFileSync(output, 'utf8'));
      products = (payload.products || []).map(normalizeProduct);
    }
  } else {
    const output = path.join(path.dirname(item.localPath), `${item.id}-products.json`);
    await runNode(EXPORT_HOST, { TEMU_EXPORT_AGENT: AGENT_PATH, TEMU_EXPORT_OUTPUT: output }, exportTimeoutMs);
    const payload = JSON.parse(fs.readFileSync(output, 'utf8'));
    products = (payload.products || []).map(normalizeProduct);
  }
  item.stage = usedDaemon ? 'extracted-via-daemon' : 'extracted-via-host';
  if (!products.length) {
    const error = new Error('图搜结果模型为空');
    error.code = 'EMPTY_PRODUCT_MODEL';
    throw error;
  }
  // 导出完成后尽力退回首页（Frida 导出依赖结果页存活，所以复位必须放在导出之后），
  // 让下一张图命中 fast_ready 快速路径；失败静默忽略
  if (process.env.TEMU_SKIP_RESET_HOME !== '1') {
    try {
      await runNode(BACK_TO_HOME_SCRIPT, {}, 20000);
    } catch {}
  }
  return products;
}

function createExecutor(mode = process.env.EXECUTOR_MODE || 'real') {
  return mode === 'mock' ? mockExecute : realExecute;
}

module.exports = { createExecutor, mockExecute, realExecute };
