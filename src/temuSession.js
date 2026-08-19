/**
 * temuSession.js
 * 通过本地 Chrome 远程调试端口（默认 9225）发现 temu.com 标签页。
 */
const http = require('http');

function fetchJson(host, port, path, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path, method: 'GET', timeout: timeoutMs },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf) });
          } catch (e) {
            resolve({ status: res.statusCode, raw: buf });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP_TIMEOUT')));
    req.end();
  });
}

async function findTemuTab(opts = {}) {
  const port = parseInt(opts.port || process.env.TEMU_CDP_PORT || '9225', 10);
  let res;
  try {
    res = await fetchJson('127.0.0.1', port, '/json');
  } catch (e) {
    const err = new Error('CDP unreachable: ' + (e.code || e.message));
    err.code = 'cdp_unreachable';
    throw err;
  }
  if (res.status !== 200 || !Array.isArray(res.json)) {
    const err = new Error('CDP /json 返回异常: status=' + res.status);
    err.code = 'cdp_invalid';
    throw err;
  }
  const candidates = res.json.filter(
    (t) => t && t.type === 'page' && typeof t.url === 'string' && /temu\.com|temucdn\.com|m\.temu\.com/i.test(t.url)
  );
  if (!candidates.length) return null;
  const tab = candidates[candidates.length - 1];
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    webSocketDebuggerUrl: tab.webSocketDebuggerUrl,
    device: 'local-chrome',
  };
}

module.exports = { findTemuTab };