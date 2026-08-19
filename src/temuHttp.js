/**
 * temuHttp.js
 * 通过 CDP WebSocket 在浏览器（已登录 temu.com）内执行 Temu 图搜请求。
 *
 * 设计参考 OZON 版 src/ozonHttp.js 的浏览器内 fetch 模式。
 * 关键点：所有调用都在已登录 tab 的页面上下文内执行，借用户自己的 Cookie / 登录态。
 */
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const temuSession = require('./temuSession');
const temuParse = require('./temuParse');

const DEFAULT_SEARCH_PATH = process.env.TEMU_SEARCH_PATH || '/api/oak/v1/marketing/searchByImage';

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.nextId = 1;
    this.pending = new Map();
    this.ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
        else resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async close() {
    try { await this.ws.close(); } catch {}
  }
}

async function searchByImageFile(opts) {
  const port = parseInt(opts.port || process.env.TEMU_CDP_PORT || '9225', 10);
  const imagePath = String(opts.imagePath || '');
  if (!imagePath || !fs.existsSync(imagePath)) {
    const e = new Error('图片不存在: ' + imagePath);
    e.code = 'file_not_found';
    throw e;
  }
  const buf = fs.readFileSync(imagePath);
  const b64 = buf.toString('base64');
  let mime = 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
  else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
  else if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') mime = 'image/webp';
  const fname = path.basename(imagePath) || 'image.jpg';

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
          const b64 = ${JSON.stringify(b64)};
          const mime = ${JSON.stringify(mime)};
          const fname = ${JSON.stringify(fname)};
          const url = ${JSON.stringify(DEFAULT_SEARCH_PATH)};
          const bin = atob(b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          const blob = new Blob([arr], { type: mime });
          const fd = new FormData();
          fd.append('image', blob, fname);
          const r = await fetch(url, {
            method: 'POST',
            body: fd,
            credentials: 'include',
            headers: { 'x-timestamp': String(Date.now()) },
          });
          const ct = r.headers.get('content-type') || '';
          const body = ct.indexOf('application/json') >= 0 ? await r.json() : await r.text();
          return JSON.stringify({ ok: r.ok, status: r.status, body });
        } catch (e) {
          return JSON.stringify({ ok: false, code: 'client_error', message: String((e && e.message) || e) });
        }
      })()
    `;
    const r = await cdp.send('Runtime.evaluate', {
      expression: js,
      awaitPromise: true,
      returnByValue: true,
    });
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

function normalizeResults(temuResponse) {
  return temuParse.parseSearchResponse(temuResponse);
}

module.exports = {
  searchByImageFile,
  normalizeResults,
  CdpClient,
};