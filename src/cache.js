// 简单的图片结果缓存：sha256(图片字节) -> { products, finishedAt, source }
// 用于 BatchService 在创建任务前查命中，避免重复走 Frida/ADB。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ResultCache {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir || path.resolve(__dirname, '..', 'runtime', 'cache');
    this.maxEntries = Number(options.maxEntries || 500);
    this.maxBytes = Number(options.maxBytes || 256 * 1024 * 1024); // 256MB 上限
    this.index = new Map(); // hash -> { file, size, finishedAt }
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.load();
  }

  load() {
    try {
      for (const name of fs.readdirSync(this.cacheDir)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(this.cacheDir, name);
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        const hash = name.replace(/\.json$/, '');
        try {
          const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!meta || !Array.isArray(meta.products)) continue;
          this.index.set(hash, { file, size: stat.size, finishedAt: meta.finishedAt || null });
        } catch {}
      }
    } catch {}
  }

  fileFor(hash) {
    return path.join(this.cacheDir, `${hash}.json`);
  }

  hashFile(filePath) {
    if (!filePath) return null;
    try {
      const hash = crypto.createHash('sha256');
      hash.update(fs.readFileSync(filePath));
      return hash.digest('hex');
    } catch {
      return null;
    }
  }

  hashBuffer(buffer) {
    if (!buffer) return null;
    try {
      return crypto.createHash('sha256').update(buffer).digest('hex');
    } catch {
      return null;
    }
  }

  get(hash) {
    if (!hash) return null;
    const meta = this.index.get(hash);
    if (!meta) return null;
    try {
      const payload = JSON.parse(fs.readFileSync(meta.file, 'utf8'));
      if (!payload || !Array.isArray(payload.products)) return null;
      return {
        hash,
        products: payload.products,
        finishedAt: payload.finishedAt || meta.finishedAt || null,
        source: payload.source || 'cache',
        size: meta.size,
      };
    } catch {
      return null;
    }
  }

  set(hash, products, meta = {}) {
    if (!hash || !Array.isArray(products) || !products.length) return false;
    const file = this.fileFor(hash);
    const payload = {
      hash,
      products,
      finishedAt: meta.finishedAt || new Date().toISOString(),
      source: meta.source || 'temu-image-search',
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(payload));
    const size = fs.statSync(file).size;
    this.index.set(hash, { file, size, finishedAt: payload.finishedAt });
    this.evictIfNeeded();
    return true;
  }

  delete(hash) {
    if (!hash) return false;
    const meta = this.index.get(hash);
    if (!meta) return false;
    try { fs.rmSync(meta.file, { force: true }); } catch {}
    this.index.delete(hash);
    return true;
  }

  clear() {
    const count = this.index.size;
    for (const { file } of this.index.values()) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
    this.index.clear();
    return count;
  }

  stats() {
    let totalSize = 0;
    for (const meta of this.index.values()) totalSize += meta.size;
    return {
      entries: this.index.size,
      totalBytes: totalSize,
      cacheDir: this.cacheDir,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
    };
  }

  evictIfNeeded() {
    if (this.index.size <= this.maxEntries) {
      let totalSize = 0;
      for (const meta of this.index.values()) totalSize += meta.size;
      if (totalSize <= this.maxBytes) return;
    }
    const sorted = [...this.index.entries()].sort((a, b) => {
      const ta = a[1].finishedAt ? new Date(a[1].finishedAt).getTime() : 0;
      const tb = b[1].finishedAt ? new Date(b[1].finishedAt).getTime() : 0;
      return ta - tb;
    });
    let totalSize = 0;
    for (const meta of this.index.values()) totalSize += meta.size;
    for (const [hash, meta] of sorted) {
      if (this.index.size <= this.maxEntries && totalSize <= this.maxBytes) break;
      this.delete(hash);
      totalSize -= meta.size;
    }
  }
}

module.exports = { ResultCache };
