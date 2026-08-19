/**
 * taskQueue.js
 * 任务队列：每条任务有 status（queued / running / done / failed_parsing），
 * 串行调度，避免 Temu 风控。
 */
const fs = require('fs');
const path = require('path');
const temuHttp = require('./temuHttp');

const tasks = new Map();
const urlBuffers = new Map();

const CONCURRENCY = parseInt(process.env.TEMU_HTTP_CONCURRENCY || '1', 10);

function accumulateUrls(taskId, urls) {
  if (!urlBuffers.has(taskId)) urlBuffers.set(taskId, []);
  urlBuffers.get(taskId).push(...urls);
}
function getBufferedUrls(taskId) {
  return urlBuffers.get(taskId) || [];
}
function getBufferedCount(taskId) {
  return getBufferedUrls(taskId).length;
}

function startTask(taskId, opts) {
  tasks.set(taskId, {
    id: taskId,
    status: 'queued',
    kind: opts.kind,
    items: [],
    results: [],
    errors: [],
    started_at: Date.now(),
    finished_at: null,
    summary: null,
    progress: { done: 0, total: opts.total || 0 },
  });
}
function get(taskId) {
  return tasks.get(taskId);
}
function markFailed(taskId, msg) {
  const t = tasks.get(taskId);
  if (!t) return;
  t.status = 'failed';
  t.finished_at = Date.now();
  t.errors.push({ message: msg, at: Date.now() });
}

async function run(taskId) {
  const t = tasks.get(taskId);
  if (!t) return;
  t.status = 'running';
  const inputs = t.kind === 'files' ? t.files.slice() : (t.urls || []).slice();
  t.progress = { done: 0, total: inputs.length };

  const queue = inputs.slice();
  const workerCount = CONCURRENCY;
  const workers = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (queue.length) {
        const inp = queue.shift();
        try {
          let temuResp = null;
          if (t.kind === 'files') {
            temuResp = await temuHttp.searchByImageFile({ imagePath: inp });
          } else {
            temuResp = await searchByUrlInBrowser(inp);
          }
          const normalized = temuHttp.normalizeResults(temuResp);
          for (const item of normalized.items) {
            item.source = inp;
            t.results.push(item);
          }
          t.summary = normalized.summary;
        } catch (e) {
          t.errors.push({ input: inp, message: String(e.message || e), code: e.code, at: Date.now() });
        } finally {
          t.progress.done += 1;
        }
      }
    })());
  }
  await Promise.all(workers);
  t.status = t.errors.length && !t.results.length ? 'failed' : 'done';
  t.finished_at = Date.now();

  try {
    const dir = path.join(__dirname, '..', 'results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${taskId}.json`),
      JSON.stringify({ task: t, items: t.results, errors: t.errors }, null, 2)
    );
  } catch (_) {}
}

async function searchByUrlInBrowser(url) {
  const temuSession = require('./temuSession');
  const { CdpClient } = temuHttp;
  const port = parseInt(process.env.TEMU_CDP_PORT || '9225', 10);
  const sess = await temuSession.findTemuTab({ port });
  if (!sess) {
    const e = new Error('未找到 temu.com 标签页');
    e.code = 'no_temu_tab';
    throw e;
  }
  const cdp = new CdpClient(sess.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const js = `
      (async () => {
        try {
          const url = ${JSON.stringify(url)};
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) return JSON.stringify({ ok:false, code:'url_fetch_failed', status: r.status });
          const blob = await r.blob();
          const fd = new FormData();
          fd.append('image', blob, 'image.jpg');
          const sr = await fetch(${JSON.stringify(process.env.TEMU_SEARCH_PATH || '/api/oak/v1/marketing/searchByImage')}, {
            method: 'POST', body: fd, credentials: 'include',
            headers: { 'x-timestamp': String(Date.now()) },
          });
          const ct = sr.headers.get('content-type') || '';
          const body = ct.indexOf('application/json') >= 0 ? await sr.json() : await sr.text();
          return JSON.stringify({ ok: sr.ok, status: sr.status, body });
        } catch (e) {
          return JSON.stringify({ ok:false, code:'client_error', message: String((e && e.message) || e) });
        }
      })()
    `;
    const r = await cdp.send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const e = new Error('CDP eval exception: ' + JSON.stringify(r.exceptionDetails));
      e.code = 'cdp_eval_error';
      throw e;
    }
    const parsed = JSON.parse(r.result.value);
    if (!parsed.ok) {
      const e = new Error(parsed.message || 'temu search failed');
      e.code = parsed.code || 'temu_search_failed';
      throw e;
    }
    return parsed.body;
  } finally {
    await cdp.close();
  }
}

module.exports = {
  accumulateUrls,
  getBufferedUrls,
  getBufferedCount,
  startTask,
  get,
  markFailed,
  run,
};