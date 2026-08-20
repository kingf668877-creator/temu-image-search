require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { randomUUID } = require('crypto');
const { BatchService } = require('./src/batch-service');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 15443);
const ROOT = __dirname;
const UPLOADS = path.join(ROOT, 'runtime', 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOADS,
  filename(req, file, callback) {
    const extension = path.extname(file.originalname).replace(/[^.a-z0-9]/gi, '') || '.jpg';
    callback(null, `${Date.now()}-${randomUUID()}${extension}`);
  },
});
const upload = multer({
  storage,
  limits: { files: 100, fileSize: 4 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    callback(null, /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype));
  },
});

function isPrivateAddress(address) {
  if (!net.isIP(address)) return true;
  if (address === '::1' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

async function downloadImage(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('只支持 HTTP/HTTPS 图片链接'), { code: 'INVALID_URL' });
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw Object.assign(new Error('图片链接不能指向本机或内网地址'), { code: 'PRIVATE_URL' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (!/^image\/(jpeg|png|webp|gif)/i.test(type)) throw new Error('链接内容不是支持的图片');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 4 * 1024 * 1024) throw new Error('图片超过 4MB');
    const extension = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : type.includes('gif') ? '.gif' : '.jpg';
    const localPath = path.join(UPLOADS, `${Date.now()}-${randomUUID()}${extension}`);
    fs.writeFileSync(localPath, bytes);
    return localPath;
  } finally {
    clearTimeout(timer);
  }
}

function createApp(options = {}) {
  const batches = options.batches || new BatchService({ mode: options.mode });
  const app = express();
  app.use(cors({ origin(origin, callback) {
    const allowed = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) || origin === 'https://kingf668877-creator.github.io';
    callback(allowed ? null : new Error('CORS_NOT_ALLOWED'), allowed);
  }}));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(ROOT));

  app.get('/api/health', (req, res) => res.json({ ok: true, version: '2.0.0', mode: options.mode || process.env.EXECUTOR_MODE || 'real', queueLength: batches.queue.length, busy: batches.running }));

  app.post('/api/batches/files', upload.array('images', 100), (req, res, next) => {
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ ok: false, code: 'NO_IMAGES', message: '没有有效图片' });
      const batch = batches.create(files.map((file) => ({ name: file.originalname, source: file.originalname, localPath: file.path })));
      res.status(202).json({ ok: true, batch });
    } catch (error) { next(error); }
  });

  app.post('/api/batches/urls', async (req, res, next) => {
    try {
      const urls = Array.isArray(req.body.urls) ? [...new Set(req.body.urls.map(String).map((url) => url.trim()).filter(Boolean))] : [];
      if (!urls.length || urls.length > 100) return res.status(400).json({ ok: false, code: 'INVALID_URL_COUNT', message: '请输入 1 至 100 条图片链接' });
      const items = [];
      for (const url of urls) {
        try {
          items.push({ name: url, source: url, previewUrl: url, localPath: await downloadImage(url) });
        } catch (error) {
          items.push({
            name: url,
            source: url,
            previewUrl: url,
            error: { code: error.code || 'IMAGE_DOWNLOAD_FAILED', message: String(error.message || error) },
          });
        }
      }
      const batch = batches.create(items);
      res.status(202).json({ ok: true, batch });
    } catch (error) { next(error); }
  });

  app.get('/api/batches/:batchId', (req, res) => {
    const batch = batches.get(req.params.batchId, true);
    if (!batch) return res.status(404).json({ ok: false, code: 'BATCH_NOT_FOUND', message: '批次不存在' });
    res.json({ ok: true, batch });
  });

  app.post('/api/batches/:batchId/items/:itemId/retry', (req, res, next) => {
    try {
      const batch = batches.retry(req.params.batchId, req.params.itemId);
      if (!batch) return res.status(404).json({ ok: false, code: 'ITEM_NOT_FOUND', message: '任务项不存在' });
      res.status(202).json({ ok: true, batch });
    } catch (error) { next(error); }
  });

  app.get('/api/batches/:batchId/export', (req, res) => {
    const batch = batches.get(req.params.batchId, true);
    if (!batch) return res.status(404).json({ ok: false, code: 'BATCH_NOT_FOUND' });
    if (req.query.format !== 'csv') return res.json(batch);
    const columns = ['source','status','goodsId','title','imageUrl','priceText','sales','productUrl','scene'];
    const quote = (value) => {
      let text = value == null ? '' : String(value);
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const rows = [columns.join(',')];
    batch.items.forEach((item) => {
      if (!item.products.length) rows.push(columns.map((column) => quote(column === 'source' ? item.source : column === 'status' ? item.status : '')).join(','));
      item.products.forEach((product) => rows.push(columns.map((column) => quote(column === 'source' ? item.source : column === 'status' ? item.status : product[column])).join(',')));
    });
    res.type('text/csv').attachment(`temu-${batch.id}.csv`).send('\ufeff' + rows.join('\r\n'));
  });

  app.use((error, req, res, next) => {
    const code = error.code || 'SERVER_ERROR';
    const status = code === 'LIMIT_FILE_SIZE' || code.startsWith('INVALID_') || code === 'PRIVATE_URL' ? 400 : 500;
    res.status(status).json({ ok: false, code, message: String(error.message || error) });
  });
  return app;
}

if (require.main === module) {
  const server = createApp().listen(PORT, HOST, () => console.log(`[temu-image-search] http://${HOST}:${PORT} · ${process.env.EXECUTOR_MODE || 'real'}`));
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`端口 ${PORT} 已被占用，请通过 PORT 显式选择其他端口`);
    process.exit(1);
  });
}

module.exports = { createApp, downloadImage, isPrivateAddress };
