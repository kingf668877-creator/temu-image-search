/**
 * Temu 图搜批量寻源 · Express 后端
 * 端口默认 5443；接管本地 Chrome（9225）的 temu.com 标签页。
 *
 * 路由：
 *   GET  /api/health           - 服务健康
 *   GET  /api/session          - Temu 会话状态
 *   POST /api/upload_urls      - 链接批量（每片 100 条，最后一片触发搜索）
 *   POST /api/upload/:taskId   - 图片批量
 *   GET  /api/status/:taskId   - 任务进度与结果
 *
 * 环境变量：
 *   PORT              - 默认 5443
 *   TEMU_CDP_PORT     - 默认 9225
 *   TEMU_HTTP_CONCURRENCY - 默认 1（Temu 风控严格，串行稳）
 *   TEMU_PROFILE_DIR  - 浏览器 user-data-dir（仅参考）
 */
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const temuSession = require('./src/temuSession');
const taskQueue = require('./src/taskQueue');

const PORT = parseInt(process.env.PORT || '5443', 10);
const CDP_PORT = parseInt(process.env.TEMU_CDP_PORT || '9225', 10);
const CONCURRENCY = parseInt(process.env.TEMU_HTTP_CONCURRENCY || '1', 10);

const UPLOADS = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const taskId = req.params.taskId;
    const dir = path.join(UPLOADS, taskId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = (file.originalname.match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0];
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const upload = multer({
  storage,
,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('UNSUPPORTED_IMAGE_TYPE'));
  },
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), port: PORT, cdp: CDP_PORT });
});

app.get('/api/session', async (req, res) => {
  try {
    const sess = await temuSession.findTemuTab({ port: CDP_PORT });
    if (!sess) {
      return res.json({
        ok: false,
        code: 'no_temu_tab',
        message: '未发现已打开的 temu.com 标签页。请打开 https://www.temu.com 并完成登录。',
      });
    }
    return res.json({
      ok: true,
      device: sess.device || 'local',
      tunnel: `127.0.0.1:${CDP_PORT}`,
      tab: { id: sess.id, url: sess.url, title: sess.title },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'session_error', message: String(e.message || e) });
  }
});

app.post('/api/upload_urls', async (req, res) => {
  try {
    const { urls, task_id, is_last_batch, expected_total } = req.body || {};
    if (!Array.isArray(urls)) {
      return res.status(400).json({ ok: false, code: 'urls_must_be_array' });
    }
    const tid = task_id || uuid();
    taskQueue.accumulateUrls(tid, urls);
    if (!is_last_batch) {
      return res.json({ ok: true, task_id: tid, buffered: urls.length, waiting_more: true });
    }
    const total = expected_total || taskQueue.getBufferedCount(tid);
    const allUrls = taskQueue.getBufferedUrls(tid);
    taskQueue.startTask(tid, { kind: 'urls', urls: allUrls, total });
    res.json({ ok: true, task_id: tid, total });
    taskQueue.run(tid).catch((e) => {
      console.error('task error', tid, e);
      taskQueue.markFailed(tid, String(e.message || e));
    });
  } catch (e) {
    res.status(500).json({ ok: false, code: 'server_error', message: String(e.message || e) });
  }
});

app.post('/api/upload/:taskId', upload.array('images', 100), async (req, res) => {
  try {
    const tid = req.params.taskId;
    const files = req.files || [];
    const localPaths = files.map((f) => f.path);
    if (!localPaths.length) {
      return res.status(400).json({ ok: false, code: 'no_files' });
    }
    taskQueue.startTask(tid, { kind: 'files', files: localPaths, total: localPaths.length });
    res.json({ ok: true, task_id: tid, count: localPaths.length });
    taskQueue.run(tid).catch((e) => {
      console.error('task error', tid, e);
      taskQueue.markFailed(tid, String(e.message || e));
    });
  } catch (e) {
    res.status(500).json({ ok: false, code: 'server_error', message: String(e.message || e) });
  }
});

app.get('/api/status/:taskId', (req, res) => {
  const tid = req.params.taskId;
  const t = taskQueue.get(tid);
  if (!t) return res.status(404).json({ ok: false, code: 'task_not_found' });
  res.json({ ok: true, task: t });
});

app.use((err, req, res, next) => {
  if (err && err.message === 'UNSUPPORTED_IMAGE_TYPE') {
    return res.status(400).json({ ok: false, code: 'unsupported_image_type' });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ ok: false, code: 'image_too_large' });
  }
  console.error(err);
  res.status(500).json({ ok: false, code: 'server_error', message: String(err.message || err) });
});

(async () => {
  temuSession.findTemuTab({ port: CDP_PORT }).catch(() => {});
  app.listen(PORT, () => {
    console.log(`[temu-image-search] listening on http://localhost:${PORT}`);
    console.log(`[temu-image-search] CDP_PORT=${CDP_PORT}  CONCURRENCY=${CONCURRENCY}`);
    console.log(`[temu-image-search] 上传目录: ${UPLOADS}`);
  });
})();