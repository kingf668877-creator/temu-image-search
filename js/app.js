// Temu 图搜批量寻源 前端交互
// 用法：把图片 / 链接 / 表格加入队列，本地模拟演示；接入真实后端时把 simulate() 换成 fetch()。

const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

const state = {
  tab: 'url',
  items: [],        // { id, src, type:'file'|'url', name, status:'pending'|'running'|'done'|'fail' }
  results: [],      // 商品结果
  page: 1,
  pageSize: 20,
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

/* ---------------- tabs ---------------- */
els.tabs.forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
function switchTab(name) {
  state.tab = name;
  els.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  els.panes.forEach(p => p.classList.toggle('active', p.dataset.pane === name));
}

/* ---------------- URL 输入 ---------------- */
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
els.startUrl.addEventListener('click', () => runSearch());

/* ---------------- 文件上传 ---------------- */
els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('dragover', e => { e.preventDefault(); els.dropzone.classList.add('drag'); });
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('drag'));
els.dropzone.addEventListener('drop', e => {
  e.preventDefault(); els.dropzone.classList.remove('drag');
  addFiles(e.dataTransfer.files);
});
els.fileInput.addEventListener('change', e => addFiles(e.target.files));
els.clearFiles.addEventListener('click', () => { state.items = []; renderPreview(); });
els.startFiles.addEventListener('click', () => runSearch());

function addFiles(fileList) {
  Array.from(fileList).forEach(f => {
    if (!f.type.startsWith('image/')) return;
    const src = URL.createObjectURL(f);
    state.items.push({ id: crypto.randomUUID(), src, type: 'file', name: f.name, status: 'pending' });
  });
  renderPreview();
}

/* ---------------- 表格上传 ---------------- */
els.tableDrop.addEventListener('click', () => els.tableInput.click());
els.tableInput.addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  alert('已选择文件：' + f.name + '\n（接入后端时由后端解析 CSV/Excel 中的图片链接列）');
  els.startTable.disabled = false;
});
els.clearTable.addEventListener('click', () => { els.tableInput.value = ''; els.startTable.disabled = true; });
els.startTable.addEventListener('click', () => runSearch());

/* ---------------- preview 渲染 ---------------- */
function renderPreview() {
  // URL 模式：从 textarea 解析
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
  // 启动按钮可用性
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

/* ---------------- 模拟搜索 ---------------- */
function runSearch() {
  if (state.items.length === 0) return;
  // 把队列渲染出来，逐个更新状态
  els.results.hidden = false;
  state.results = [];
  state.items.forEach((it, idx) => {
    it.status = 'running';
    setTimeout(() => {
      // 模拟命中：返回 1 张商品（演示用）
      const mock = mockResult(idx);
      state.results.push({ source: it.src, ...mock });
      it.status = 'done';
      renderResults();
      renderPreview();
    }, 350 + idx * 250);
  });
  renderPreview();
}

function mockResult(i) {
  return {
    goods_id: '601099596' + String(100000 + i).padStart(6, '0'),
    title: ['6 Sections Rotating Makeup Organizer Dollhouse-Style...', 'Premium Stainless Steel...', 'Soft Plush Cartoon Duck...'][i % 3],
    thumb_url: 'https://img.kwcdn.com/product/fancy/ed251e88-d847-4fd9-bca7-8cd7201052b9.jpg',
    full_url: 'https://www.temu.com/goods.html?goods_id=601099596' + String(100000 + i).padStart(6, '0'),
    price: '$' + (5 + (i % 5) * 3.7).toFixed(2),
    rating: (4.3 + (i % 5) * 0.1).toFixed(1),
    reviews: 50 + i * 23,
    sold: 100 + i * 41,
  };
}

/* ---------------- 结果渲染 ---------------- */
function renderResults() {
  const total = state.results.length;
  els.resultsCount.textContent = total ? `共 ${total} 条` : '';
  const pageSize = state.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.page > totalPages) state.page = totalPages;
  els.pageCurrent.textContent = state.page;
  els.pageTotal.textContent = totalPages;
  const slice = state.results.slice((state.page - 1) * pageSize, state.page * pageSize);
  els.resultsGrid.innerHTML = slice.map(r => `
    <article class="result-card">
      <div class="result-thumb" style="background-image:url('${escapeAttr(r.thumb_url)}')">
        <span class="source-tag">源图 → 同款</span>
      </div>
      <div class="result-body">
        <h4 class="result-title">${escapeHtml(r.title)}</h4>
        <div class="result-price">
          <span class="price-main">${escapeHtml(r.price)}</span>
          ${r.price_old ? `<span class="price-old">${escapeHtml(r.price_old)}</span>` : ''}
        </div>
        <div class="result-meta">
          <span class="rating">★ ${r.rating}</span>
          <span>${r.reviews} 条评价</span>
          <span>${r.sold}+ 已售</span>
        </div>
        <div class="result-actions">
          <a href="${escapeAttr(r.full_url)}" target="_blank" rel="noopener">打开商品</a>
          <a class="alt" href="javascript:;" data-id="${r.goods_id}">复制 ID</a>
        </div>
      </div>
    </article>
  `).join('');
  // 复制 ID
  $$('.result-actions a.alt', els.resultsGrid).forEach(a => a.addEventListener('click', e => {
    navigator.clipboard.writeText(a.dataset.id);
    a.textContent = '已复制';
    setTimeout(() => a.textContent = '复制 ID', 1200);
  }));
}

/* ---------------- pager ---------------- */
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

/* ---------------- 导出 ---------------- */
els.exportJson.addEventListener('click', () => download('temu_results.json', JSON.stringify(state.results, null, 2), 'application/json'));
els.exportCsv.addEventListener('click', () => {
  const cols = ['source','goods_id','title','price','rating','reviews','sold','thumb_url','full_url'];
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

/* ---------------- helpers ---------------- */
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

// init
renderPreview();