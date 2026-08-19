// Temu 图搜批量寻源 前端交互
// 接入真实后端：localhost:5443

const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

const BACKEND = (window.TEMU_BACKEND || 'http://localhost:5443');

const state = {
  tab: 'url',
  items: [],
  results: [],
  page: 1,
  pageSize: 20,
  taskId: null,
  pollTimer: null,
};

const els = {
  tabs: $$('.tab'),
  panes: $$('.tab-pane'),
  urlTextarea: $('#url-textarea'),
  importText: $('#import-text'),
  clearUrl: $('#clear-url'),
  startUrl: $('#start-url'),
  fileInput: $('#file-input'),
  dropzone: $('#dropzone'),
  clearFiles: $('#clear-files'),
  startFiles: $('#start-files'),
  tableInput: $('#table-input'),
  tableDrop: $('#table-drop'),
  clearTable: $('#clear-table'),
  startTable: $('#start-table'),
  preview: $('#preview'),
  previewCount: $('#preview-count'),
  previewEta: $('#preview-eta'),
  previewGrid: $('#preview-grid'),
  previewClear: $('#preview-clear'),
  results: $('#results'),
  resultsCount: $('#results-count'),
  resultsGrid: $('#results-grid'),
  pageSize: $('#page-size'),
  pageCurrent: $('#page-current'),
  pageTotal: $('#page-total'),
  pageJump: $('#page-jump'),
  pageGo: $('#page-go'),
  pagerBtns: $$('.page-btn'),
  exportJson: $('#export-json'),
  exportCsv: $('#export-csv'),
};

els.tabs.forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
function switchTab(name) {
  state.tab = name;
  els.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  els.panes.forEach(p => p.classList.toggle('active', p.dataset.pane === name));
}

els.importText.addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.txt,.csv,.list';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { els.urlTextarea.value = String(r.result || ''); renderPreview(); };
    r.readAsText(f);
  };
  inp.click();
});
els.clearUrl.addEventListener('click', () => { els.urlTextarea.value = ''; renderPreview(); });
els.urlTextarea.addEventListener('input', renderPreview);
els.startUrl.addEventListener('click', () => runSearchUrls());

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('dragover', e => { e.preventDefault(); els.dropzone.classList.add('drag'); });
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('drag'));
els.dropzone.addEventListener('drop', e => {
  e.preventDefault(); els.dropzone.classList.remove('drag');
  addFiles(e.dataTransfer.files);
});
els.fileInput.addEventListener('change', e => addFiles(e.target.files));
els.clearFiles.addEventListener('click', () => { state.items = []; renderPreview(); });
els.startFiles.addEventListener('click', () => runSearchFiles());

function addFiles(fileList) {
  Array.from(fileList).forEach(f => {
    if (!f.type.startsWith('image/')) return;
    const src = URL.createObjectURL(f);
    state.items.push({ id: crypto.randomUUID(), src, type: 'file', name: f.name, file: f, status: 'pending' });
  });
  renderPreview();
}

els.tableDrop.addEventListener('click', () => els.tableInput.click());
els.tableInput.addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  alert('已选择文件：' + f.name + '。\n（首版仅支持链接批量 + 图片批量；表格批量后续版本加入。）');
});
els.clearTable.addEventListener('click', () => { els.tableInput.value = ''; });

function renderPreview() {
  if (state.tab === 'url') {
    const lines = els.urlTextarea.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    state.items = lines.map(url => ({ id: crypto.randomUUID(), src: url, type: 'url', name: url, status: 'pending' }));
  }
  els.preview.hidden = state.items.length === 0;
  els.previewCount.textContent = state.items.length;
  els.previewEta.textContent = state.items.length === 0 ? '--' : `约 ${Math.max(1, Math.ceil(state.items.length * 4 / 60))} 分钟`;
  els.previewGrid.innerHTML = '';
  state.items.forEach(it => {
    const node = document.createElement('div');
    node.className = 'preview-item';
    node.innerHTML = `
      <img src="${escapeAttr(it.src)}" loading="lazy" alt=""
           onerror="this.style.background='#f3c69d';this.removeAttribute('src')">
      <span class="status ${it.status}">${labelOf(it.status)}</span>
    `;
    els.previewGrid.appendChild(node);
  });
  els.startUrl.disabled = state.items.length === 0;
  els.startFiles.disabled = state.items.length === 0;
}
function labelOf(s) { return ({ pending: '待搜索', running: '搜索中', done: '完成', fail: '失败' })[s] || s; }

els.previewClear.addEventListener('click', () => {
  state.items = [];
  els.urlTextarea.value = '';
  els.fileInput.value = '';
  renderPreview();
});

async function runSearchUrls() {
  if (state.items.length === 0) return;
  const urls = state.items.map(it => it.src);
  const CHUNK = 100;
  els.results.hidden = false;
  state.results = [];
  state.taskId = null;
  try {
    for (let i = 0; i < urls.length; i += CHUNK) {
      const slice = urls.slice(i, i + CHUNK);
      const isLast = (i + CHUNK) >= urls.length;
      const resp = await fetch(BACKEND + '/api/upload_urls', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          urls: slice,
          task_id: state.taskId,
          is_last_batch: isLast,
          expected_total: urls.length,
        }),
      });
      const data = await resp.json();
      if (!data.ok) {
        alert('提交失败: ' + (data.message || data.code));
        return;
      }
      state.taskId = data.task_id;
      state.items.forEach(it => it.status = 'running');
      renderPreview();
    }
    pollStatus();
  } catch (e) {
    alert('提交失败: ' + (e.message || e));
  }
}

async function runSearchFiles() {
  if (state.items.length === 0) return;
  els.results.hidden = false;
  state.results = [];
  state.taskId = crypto.randomUUID();
  const fd = new FormData();
  state.items.forEach(it => { if (it.file) fd.append('images', it.file); });
  try {
    state.items.forEach(it => it.status = 'running');
    renderPreview();
    const resp = await fetch(BACKEND + '/api/upload/' + state.taskId, {
      method: 'POST', body: fd,
    });
    const data = await resp.json();
    if (!data.ok) {
      alert('提交失败: ' + (data.message || data.code));
      return;
    }
    pollStatus();
  } catch (e) {
    alert('提交失败: ' + (e.message || e));
  }
}

function pollStatus() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (!state.taskId) return;
    try {
      const resp = await fetch(BACKEND + '/api/status/' + state.taskId);
      const data = await resp.json();
      if (!data.ok) return;
      const t = data.task;
      if (t.progress && t.progress.total) {
        els.previewCount.textContent = `${t.progress.done}/${t.progress.total}`;
      }
      if (t.status === 'done' || t.status === 'failed') {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        state.results = (t.results || []).slice();
        renderResults();
        state.items.forEach(it => it.status = t.status === 'done' ? 'done' : 'fail');
        renderPreview();
      }
    } catch (e) {
      console.error('poll error', e);
    }
  }, 1500);
}

function renderResults() {
  const total = state.results.length;
  els.resultsCount.textContent = total ? `共 ${total} 条` : '';
  const pageSize = state.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.page > totalPages) state.page = totalPages;
  els.pageCurrent.textContent = state.page;
  els.pageTotal.textContent = totalPages;
  const slice = state.results.slice((state.page - 1) * pageSize, state.page * pageSize);
  els.resultsGrid.innerHTML = slice.map(r => {
    const unknown = (label) => '<span style="color:#f3c69d">'+label+'</span>';
    const meta = [];
    meta.push(r.score != null ? `<span class="rating">★ ${r.score}</span>` : unknown('★ 待定'));
    meta.push(r.review_count != null ? `<span>${r.review_count} 条评价</span>` : unknown('评分数 待定'));
    meta.push(r.sales != null ? `<span>${r.sales}+ 已售</span>` : unknown('销量 待定'));
    return `
    <article class="result-card">
      <div class="result-thumb" style="background-image:url('${escapeAttr(r.thumb_url || '')}')">
        <span class="source-tag">源图 → 同款</span>
      </div>
      <div class="result-body">
        <h4 class="result-title">${escapeHtml(r.title || '(标题待校准)')}</h4>
        <div class="result-price">
          <span class="price-main">${r.price ? escapeHtml(r.price) : '<span style="color:#f3c69d">价格 待定</span>'}</span>
          ${r.price_old ? `<span class="price-old">${escapeHtml(r.price_old)}</span>` : ''}
        </div>
        <div class="result-meta">${meta.join('')}</div>
        <div class="result-actions">
          <a href="${escapeAttr(r.full_url || '#')}" target="_blank" rel="noopener">打开商品</a>
          <a class="alt" href="javascript:;" data-id="${r.goods_id || ''}">复制 ID</a>
        </div>
      </div>
    </article>
  `}).join('');
  $$('.result-actions a.alt', els.resultsGrid).forEach(a => a.addEventListener('click', () => {
    if (!a.dataset.id) return;
    navigator.clipboard.writeText(a.dataset.id);
    a.textContent = '已复制';
    setTimeout(() => a.textContent = '复制 ID', 1200);
  }));
}

els.pagerBtns.forEach(b => b.addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(state.results.length / state.pageSize));
  if (b.dataset.page === 'first') state.page = 1;
  if (b.dataset.page === 'prev')  state.page = Math.max(1, state.page - 1);
  if (b.dataset.page === 'next')  state.page = Math.min(totalPages, state.page + 1);
  if (b.dataset.page === 'last')  state.page = totalPages;
  renderResults();
}));
els.pageGo.addEventListener('click', () => {
  const v = Math.max(1, parseInt(els.pageJump.value, 10) || 1);
  const totalPages = Math.max(1, Math.ceil(state.results.length / state.pageSize));
  state.page = Math.min(totalPages, v);
  renderResults();
});
els.pageSize.addEventListener('change', e => {
  state.pageSize = parseInt(e.target.value, 10) || 20;
  state.page = 1;
  renderResults();
});

els.exportJson.addEventListener('click', () => download('temu_results.json', JSON.stringify(state.results, null, 2), 'application/json'));
els.exportCsv.addEventListener('click', () => {
  const cols = ['source','goods_id','title','thumb_url','price','price_old','sales','score','review_count','category','full_url'];
  const rows = [cols.join(',')];
  for (const r of state.results) rows.push(cols.map(c => csv(r[c])).join(','));
  download('temu_results.csv', rows.join('\n'), 'text/csv');
});
function download(name, data, mime) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function csv(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

function escapeHtml(s) { return String(s==null?'':s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

renderPreview();