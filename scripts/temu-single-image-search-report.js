const fs = require('fs');
const path = require('path');
const { AdbClient } = require('./AdbClient');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = process.env.TEMU_DIAGNOSTICS_DIR || path.join(ROOT, 'runtime', 'diagnostics');
const INPUT_IMAGE = process.env.TEMU_IMAGE;
const REMOTE_IMAGE = '/sdcard/Pictures/temu-search-test.png';
const PACKAGE = 'com.einnovation.temu';
const PICKER_PACKAGES = [
  'com.android.providers.media.module',
  'com.android.documentsui'
];
const TARGET_FILE = path.basename(REMOTE_IMAGE);
const FAST_MODE = process.env.TEMU_FAST_MODE === '1';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeXml(value = '') {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseNodes(xml) {
  const nodes = [];
  for (const match of xml.matchAll(/<node\s+([^>]+?)(?:\/>|>)/g)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/([\w:-]+)=(['"])(.*?)\2/g)) {
      attrs[attr[1]] = decodeXml(attr[3]);
    }
    nodes.push(attrs);
  }
  return nodes;
}

function rectOf(bounds) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(bounds || '');
  if (!match) return null;
  const [, x1, y1, x2, y2] = match.map(Number);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x1, y1, x2, y2 };
}

function centerOf(bounds) {
  const rect = rectOf(bounds);
  if (!rect) return null;
  return {
    x: Math.round((rect.x1 + rect.x2) / 2),
    y: Math.round((rect.y1 + rect.y2) / 2)
  };
}

function containsBounds(containerBounds, childBounds) {
  const outer = rectOf(containerBounds);
  const inner = rectOf(childBounds);
  return Boolean(outer && inner && inner.x1 >= outer.x1 && inner.y1 >= outer.y1 &&
    inner.x2 <= outer.x2 && inner.y2 <= outer.y2);
}

function nodeText(node) {
  return `${node.text || ''} ${node['content-desc'] || ''}`.trim();
}

function findNode(nodes, predicate) {
  return nodes.find((node) => centerOf(node.bounds) && predicate(node));
}

function countNodes(nodes, predicate) {
  return nodes.filter(predicate).length;
}

function validateHome(state) {
  let camera = findNode(state.nodes, (node) => {
    const label = nodeText(node);
    return /^(按照片搜索|search by (photo|image)|image search)$/i.test(label) &&
      node.clickable === 'true';
  });
  if (!camera) {
    const searchBar = state.nodes.find((node) =>
      (node['resource-id'] || '').endsWith('/ll_search_entrance'));
    const searchButton = state.nodes.find((node) =>
      /^search$/i.test(node['content-desc'] || '') &&
      searchBar && containsBounds(searchBar.bounds, node.bounds));
    camera = findNode(state.nodes, (node) =>
      node.class === 'android.widget.ImageView' && node.clickable === 'true' &&
      searchBar && containsBounds(searchBar.bounds, node.bounds) &&
      (!searchButton || rectOf(node.bounds).x2 <= rectOf(searchButton.bounds).x1));
  }
  return {
    valid: Boolean(camera) && state.xml.includes(PACKAGE),
    reason: camera ? null : '首页未找到可点击的图搜相机入口',
    target: camera || null
  };
}

function validateImageMenu(state) {
  const album = findNode(state.nodes, (node) =>
    /^(从相册中选择|choose from (gallery|album)|select from (gallery|album))$/i.test(node.text.trim()) &&
    node.clickable === 'true');
  return {
    valid: Boolean(album) && state.xml.includes(PACKAGE),
    reason: album ? null : '图搜菜单未出现“从相册中选择”',
    target: album || null
  };
}

function validatePicker(state) {
  const pickerPackage = PICKER_PACKAGES.find((packageName) =>
    state.xml.includes(`package="${packageName}"`));
  let target = findNode(state.nodes, (node) => {
    const description = node['content-desc'] || '';
    return description === TARGET_FILE || description.startsWith(`${TARGET_FILE},`);
  });
  if (!target && pickerPackage === 'com.android.providers.media.module') {
    const recentHeader = state.nodes.find((node) => /^recent$/i.test(node.text.trim()));
    const photos = state.nodes
      .filter((node) => node.clickable === 'true' && /^Photo taken on /i.test(node['content-desc'] || ''))
      .sort((a, b) => {
        const aRect = rectOf(a.bounds);
        const bRect = rectOf(b.bounds);
        return (aRect.y1 - bRect.y1) || (aRect.x1 - bRect.x1);
      });
    if (recentHeader && photos.length) target = photos[0];
  }
  return {
    valid: Boolean(pickerPackage) && Boolean(target),
    reason: pickerPackage && target
      ? null
      : !pickerPackage
        ? '当前页面不是受支持的系统图片选择器'
        : '系统图片选择器中未找到可验证的最新目标图片',
    target: target || null,
    evidence: {
      picker_package: pickerPackage || null,
      target_description: target?.['content-desc'] || TARGET_FILE,
      selection_rule: target?.['content-desc']?.startsWith('Photo taken on ')
        ? 'recent-first-photo-after-just-in-time-push'
        : 'exact-file-name'
    }
  };
}

function validateResult(state) {
  const imageSearchTitle = state.nodes.some((node) =>
    /^(图像搜索|图片搜索|image search)$/i.test(node.text.trim()));
  const goodsCount = countNodes(state.nodes, (node) =>
    (node['resource-id'] || '').endsWith('/goods_item_container') &&
    node.clickable === 'true' && Boolean(centerOf(node.bounds)));
  const activeSearchInputs = state.nodes.filter((node) => {
    const id = node['resource-id'] || '';
    const isSearchInput = node.class === 'android.widget.EditText' || id.endsWith('/search_et_input');
    return isSearchInput && (node.focused === 'true' || node.clickable === 'true' || node.enabled === 'true');
  });
  const suggestionSignals = state.nodes.filter((node) =>
    /搜索建议|历史搜索|热门搜索|猜你想搜/.test(nodeText(node)));
  const packageVisible = state.xml.includes(PACKAGE);
  const reasons = [];
  if (!packageVisible) reasons.push('选择图片后未返回 Temu');
  if (!imageSearchTitle) reasons.push('未检测到明确的图像搜索页面标题');
  if (goodsCount < 2) reasons.push(`可见商品卡片不足，当前仅 ${goodsCount} 个`);
  if (activeSearchInputs.length) reasons.push('检测到仍可编辑或聚焦的文字搜索框');
  if (suggestionSignals.length) reasons.push('检测到文字搜索建议或历史搜索状态');
  return {
    valid: reasons.length === 0,
    reason: reasons.join('；') || null,
    evidence: {
      package_visible: packageVisible,
      image_search_title: imageSearchTitle,
      visible_goods_count: goodsCount,
      active_search_input_count: activeSearchInputs.length,
      suggestion_signal_count: suggestionSignals.length
    }
  };
}

async function saveState(client, name, options = {}) {
  const xmlRemote = `/sdcard/${name}.xml`;
  const pngRemote = `/data/local/tmp/${name}.png`;
  const attempts = options.attempts || 6;
  const retryDelayMs = options.retryDelayMs || 1200;
  let xml = '';
  const dumpDiagnostics = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await client.shell(`rm -f ${xmlRemote}`);
    const dumpOutput = await client.shell(`uiautomator dump --compressed ${xmlRemote}`);
    xml = await client.readTextFile(xmlRemote);
    dumpDiagnostics.push({
      attempt,
      dump_output: dumpOutput.trim(),
      xml_length: xml.length
    });
    if (xml.includes('<hierarchy')) break;
    await sleep(retryDelayMs);
  }

  const xmlPath = path.join(OUTPUT_DIR, `${name}.xml`);
  const pngPath = path.join(OUTPUT_DIR, `${name}.png`);
  if (!FAST_MODE) {
    await client.screencap(pngRemote);
    const pngBase64 = await client.readFileBase64(pngRemote);
    fs.writeFileSync(pngPath, Buffer.from(pngBase64, 'base64'));
  }
  if (!xml.includes('<hierarchy')) {
    const diagnosticPath = path.join(OUTPUT_DIR, `${name}-dump-diagnostics.json`);
    fs.writeFileSync(diagnosticPath, JSON.stringify(dumpDiagnostics, null, 2), 'utf8');
    throw new Error(`${name} 页面结构连续 ${attempts} 次导出为空，诊断已保存`);
  }
  fs.writeFileSync(xmlPath, xml, 'utf8');
  return {
    name,
    xml,
    nodes: parseNodes(xml),
    xml_path: xmlPath,
    screenshot_path: FAST_MODE ? null : pngPath,
    activity: FAST_MODE ? null : await client.currentActivity(),
    dump_attempts: dumpDiagnostics.length
  };
}

async function tapValidatedTarget(client, validation, stage) {
  if (!validation.valid || !validation.target) {
    throw new Error(`${stage}校验失败：${validation.reason}`);
  }
  const point = centerOf(validation.target.bounds);
  if (!point) throw new Error(`${stage}目标控件没有有效 bounds`);
  const tap = await client.tap(point.x, point.y);
  return { point, bounds: validation.target.bounds, tap };
}

async function waitForState(client, name, validator, attempts = 6, delayMs = 1500) {
  let lastState;
  let lastValidation;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(delayMs);
    lastState = await saveState(client, name);
    lastValidation = validator(lastState);
    if (lastValidation.valid) {
      return { state: lastState, validation: lastValidation, attempt };
    }
  }
  throw new Error(`${name}校验失败：${lastValidation?.reason || '页面状态未知'}`);
}

async function recoverVerifiedHome(client, firstState, maxBacks = 5) {
  let state = firstState;
  for (let backCount = 0; backCount <= maxBacks; backCount++) {
    const validation = validateHome(state);
    if (validation.valid) return { state, validation, back_count: backCount };
    if (backCount === maxBacks) break;
    await client.keyevent(4);
    await sleep(1200);
    state = await saveState(client, `01-home-recovery-${backCount + 1}`);
  }
  throw new Error('无法从当前页面安全返回带“按照片搜索”入口的首页');
}

function publicState(state) {
  return {
    name: state.name,
    xml_path: state.xml_path,
    screenshot_path: state.screenshot_path,
    activity: state.activity
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!INPUT_IMAGE) {
    throw new Error('严格图搜要求通过 TEMU_IMAGE 显式指定真实商品图片');
  }
  if (!fs.existsSync(INPUT_IMAGE)) {
    throw new Error(`图片不存在: ${INPUT_IMAGE}`);
  }

  const runId = `image-search-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const client = new AdbClient();
  const result = {
    run_id: runId,
    mode: 'strict-image-search',
    started_at: new Date().toISOString(),
    input_image: INPUT_IMAGE,
    remote_image: REMOTE_IMAGE,
    valid_image_search: false,
    validation_chain: [],
    steps: {}
  };

  const reportPath = path.join(OUTPUT_DIR, 'single-report.json');
  try {
    result.steps.start = await client.startApp(PACKAGE);
    await sleep(7000);

    const initialState = await saveState(client, '01-initial-state', {
      attempts: 8,
      retryDelayMs: 1500
    });
    const home = await recoverVerifiedHome(client, initialState);
    result.steps.initial_state = publicState(initialState);
    result.steps.home = publicState(home.state);
    result.steps.home_recovery_back_count = home.back_count;
    result.validation_chain.push({ stage: 'home-camera-entry', ...home.validation, target: undefined });
    result.steps.camera_tap = await tapValidatedTarget(client, home.validation, '首页图搜入口');

    const menu = await waitForState(client, '02-image-menu', validateImageMenu, 4, 1000);
    result.steps.image_menu = publicState(menu.state);
    result.validation_chain.push({ stage: 'image-search-menu', ...menu.validation, target: undefined });
    result.steps.push = await client.pushFile(INPUT_IMAGE, REMOTE_IMAGE);
    result.steps.scan = await client.scanMedia(REMOTE_IMAGE);
    result.steps.image_published_at = new Date().toISOString();
    result.steps.album_tap = await tapValidatedTarget(client, menu.validation, '图搜菜单');

    const picker = await waitForState(client, '03-system-picker', validatePicker, 6, 1200);
    result.steps.system_picker = publicState(picker.state);
    result.validation_chain.push({ stage: 'system-image-picker', ...picker.validation, target: undefined });
    result.steps.image_tap = await tapValidatedTarget(client, picker.validation, '系统图片选择器');

    const final = await waitForState(client, '04-validated-result', validateResult, 8, 2000);
    result.steps.result = publicState(final.state);
    result.validation_chain.push({ stage: 'image-search-result', ...final.validation });
    result.valid_image_search = true;
    result.result_evidence = final.validation.evidence;
    result.finished_at = new Date().toISOString();
  } catch (error) {
    result.error = error.message;
    result.finished_at = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf8');
    throw error;
  }

  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    run_id: result.run_id,
    valid_image_search: result.valid_image_search,
    report: reportPath,
    evidence: result.result_evidence
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
