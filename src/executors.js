const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { normalizeProduct } = require('./product-normalizer');

const ROOT = path.resolve(__dirname, '..');
const SEARCH_SCRIPT = process.env.TEMU_SEARCH_SCRIPT || path.join(ROOT, 'scripts', 'temu-single-image-search-report.js');
const EXPORT_HOST = process.env.TEMU_EXPORT_HOST || path.join(__dirname, 'frida-export-host.js');
const AGENT_PATH = process.env.TEMU_EXPORT_AGENT || path.join(ROOT, 'scripts', 'temu-export-image-search-products-agent.js');
const SEARCH_TIMEOUT_MS = Number(process.env.TEMU_SEARCH_TIMEOUT_MS || 360000);

function runNode(script, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error(`步骤超时：${path.basename(script)}`);
      error.code = 'EXECUTOR_TIMEOUT';
      reject(error);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const message = (stderr || stdout || `退出码 ${code}`).trim();
        const error = new Error(message);
        error.code = /IMAGE_NOT_CLEAR|图片主体不清晰|product is clearly visible/i.test(message)
          ? 'IMAGE_NOT_CLEAR'
          : 'DEVICE_STEP_FAILED';
        reject(error);
      } else resolve(stdout.trim());
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

async function realExecute(item, onProgress = () => {}) {
  if (!item.localPath || !fs.existsSync(item.localPath)) {
    const error = new Error('待搜索图片不存在');
    error.code = 'IMAGE_NOT_FOUND';
    throw error;
  }
  onProgress('preparing');
  onProgress('searching');
  await runNode(SEARCH_SCRIPT, { TEMU_IMAGE: item.localPath, TEMU_FAST_MODE: '1' }, SEARCH_TIMEOUT_MS);
  onProgress('extracting');
  const output = path.join(path.dirname(item.localPath), `${item.id}-products.json`);
  await runNode(EXPORT_HOST, { TEMU_EXPORT_AGENT: AGENT_PATH, TEMU_EXPORT_OUTPUT: output }, 90000);
  const payload = JSON.parse(fs.readFileSync(output, 'utf8'));
  const products = (payload.products || []).map(normalizeProduct);
  if (!products.length) {
    const error = new Error('图搜结果模型为空');
    error.code = 'EMPTY_PRODUCT_MODEL';
    throw error;
  }
  return products;
}

function createExecutor(mode = process.env.EXECUTOR_MODE || 'real') {
  return mode === 'mock' ? mockExecute : realExecute;
}

module.exports = { createExecutor, mockExecute, realExecute };
