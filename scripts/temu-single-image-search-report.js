const fs = require('fs');
const path = require('path');
const { AdbClient } = require('./AdbClient');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = process.env.TEMU_DIAGNOSTICS_DIR || path.join(ROOT, 'runtime', 'diagnostics');
const INPUT_IMAGE = process.env.TEMU_IMAGE;
// 每个任务使用唯一远端文件名，避免 Android MediaStore/相册复用固定路径的旧缩略图。
const inputExtension = path.extname(INPUT_IMAGE || '').toLowerCase();
const safeExtension = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(inputExtension) ? inputExtension : '.jpg';
const remoteToken = path.basename(INPUT_IMAGE || 'image', inputExtension).replace(/[^a-z0-9_-]/gi, '-').slice(-48);
const taskToken = String(process.env.TEMU_TASK_ID || `${Date.now()}-${process.pid}`)
  .replace(/[^a-z0-9_-]/gi, '-')
  .slice(-48);
// 任务标识必须参与路径：同一文件重试也会生成新媒体记录，避免系统选择器复用旧缩略图。
const REMOTE_IMAGE = `/sdcard/Pictures/temu-search-${taskToken}-${remoteToken}${safeExtension}`;
const PACKAGE = 'com.einnovation.temu';
const PICKER_PACKAGES = [
  'com.android.providers.media.module',
  'com.android.documentsui'
];
const TARGET_FILE = path.basename(REMOTE_IMAGE);
// TEMU_FAST_MODE:
//   1 -> disable screencap（节省时间）
//   2 -> 已就绪路径：跳过 startApp + 7s 等待 + 首页恢复，假定 Temu 已在首页
// TEMU_FAST_PRECISE:
//   0 -> 关闭：dump 默认 6 次重试 1200ms（老行为，调试用）
//   1 -> 开启（默认）：dump 默认 1 次重试 400ms，依靠 Frida/校验 fallback
// 任意非 0 的快速模式都关闭截图诊断；模式 2 同时启用首页复用。
const FAST_MODE = process.env.TEMU_FAST_MODE !== '0';
const FAST_READY = process.env.TEMU_FAST_MODE === '2';
const FAST_PRECISE = process.env.TEMU_FAST_PRECISE !== '0';
// 点击图片后由 Frida 商品监听器判断结果是否到达；跳过不稳定的结果页结构等待。
const SKIP_RESULT_WAIT = process.env.TEMU_SKIP_RESULT_WAIT === '1';

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
    const recentHeader = state.nodes.find((node) =>
      /^(recent|neueste)$/i.test(node.text.trim()));
    const photos = state.nodes
      .filter((node) => node.clickable === 'true' &&
        /^(photo taken on |foto wurde aufgenommen am )/i.test(node['content-desc'] || ''))
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
  // FAST_PRECISE 开启（默认）：dump 只尝试一次 + 短超时，完全交给外层 waitForState 轮询。
  // Frida hook 已经在监听商品仓库写入，选图阶段仅需 minimal 校验；多轮 dump 反而把每张图拖到分钟级。
  const attempts = options.attempts || (FAST_PRECISE ? 1 : 3);
  const retryDelayMs = options.retryDelayMs || (FAST_PRECISE ? 200 : 800);
  const dumpTimeoutMs = options.dumpTimeoutMs || (FAST_PRECISE ? 7000 : 10000);
  let xml = '';
  const dumpDiagnostics = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // 页面动画/请求期间 uiautomator 偶发阻塞；短超时后交给外层轮询，
    // 避免单次 dump 占满默认 20 秒并把整张图拖到分钟级。
    try {
      await client.shell(`rm -f ${xmlRemote}`, { timeout: 2500 }).catch(() => {});
      // 此云手机上 compressed dump 会被系统直接终止；标准导出更大但稳定，
      // 页面解析仍只读取所需节点，避免把失败重试拖成长任务。
      const dumpOutput = await client.shell(`uiautomator dump ${xmlRemote}`, { timeout: dumpTimeoutMs });
      xml = await client.readTextFile(xmlRemote, { timeout: 4000 }).catch(() => '');
      dumpDiagnostics.push({
        attempt,
        dump_output: dumpOutput.trim(),
        xml_length: xml.length
      });
    } catch (error) {
      xml = '';
      dumpDiagnostics.push({ attempt, dump_output: String(error.message || error), xml_length: 0 });
      // uiautomator 超时后可能继续占用 accessibility 连接，主动终止残留进程，避免污染下一次或下一张图。
      await client.shell('pkill -f "uiautomator dump" 2>/dev/null || true', { timeout: 2500 }).catch(() => {});
    }
    if (xml.includes('<hierarchy')) break;
    if (attempt < attempts) await sleep(retryDelayMs);
  }

  const xmlPath = path.join(OUTPUT_DIR, `${name}.xml`);
  const pngPath = path.join(OUTPUT_DIR, `${name}.png`);
  if (!FAST_MODE && xml.includes('<hierarchy')) {
    await client.screencap(pngRemote);
    const pngBase64 = await client.readFileBase64(pngRemote);
    fs.writeFileSync(pngPath, Buffer.from(pngBase64, 'base64'));
  }
  if (!xml.includes('<hierarchy')) {
    const diagnosticPath = path.join(OUTPUT_DIR, `${name}-dump-diagnostics.json`);
    fs.writeFileSync(diagnosticPath, JSON.stringify(dumpDiagnostics, null, 2), 'utf8');
    // 页面切换中 dump 暂时为空是常态：允许调用方（waitForState 轮询）把它当作
    // 一次失败尝试继续轮询，而不是让整个任务直接崩掉
    if (options.throwOnEmpty === false) {
      return { name, xml: '', nodes: [], xml_path: xmlPath, screenshot_path: null, activity: null, dump_attempts: dumpDiagnostics.length, dump_empty: true };
    }
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
  if (!validation || !validation.valid) {
    throw new Error(`${stage}校验失败：${validation?.reason || '未知'}`);
  }
  let point = null;
  let bounds = null;
  if (validation.target) {
    point = centerOf(validation.target.bounds);
    bounds = validation.target.bounds;
  }
  // 盲点兜底：使用历史坐标。点击失败也比直接抛错更可能完成本次图搜。
  if (!point && stage === '首页图搜入口') {
    point = { x: 555, y: 93 };
    bounds = '[518,56][592,130]';
  } else if (!point && stage === '图搜菜单') {
    // Temu 图搜菜单里 “从相册选择” 通常在底部第三行；
    // 历史坐标 (360, 1019) 对应选择器入口。
    point = { x: 360, y: 1019 };
    bounds = '[0,971][720,1067]';
  } else if (!point && stage === '系统图片选择器') {
    // 系统图片选择器中第一张图通常是最新一张（我们刚 push 的），
    // 历史坐标 (118, 1020) 是底部相册首图。
    point = { x: 118, y: 1020 };
    bounds = '[0,902][236,1138]';
  } else if (!point) {
    throw new Error(`${stage}目标控件没有有效 bounds`);
  }
  const tap = await client.tap(point.x, point.y);
  return { point, bounds, tap };
}

async function waitForState(client, name, validator, attempts = 6, delayMs = 1500, firstDelayMs = null, budgetCheck = null) {
  let lastState;
  let lastValidation;
  let dumpFailed = true;
  let attempt = 0;
  for (attempt = 1; attempt <= attempts; attempt++) {
    if (budgetCheck) budgetCheck();
    await sleep(attempt === 1 && firstDelayMs != null ? firstDelayMs : delayMs);
    if (budgetCheck) budgetCheck();
    // dump 为空不算致命错误：当作一次失败尝试，继续下一轮
    lastState = await saveState(client, name, { throwOnEmpty: false });
    if (budgetCheck) budgetCheck();
    if (lastState.dump_empty) {
      lastValidation = { valid: false, reason: '页面结构导出暂时为空（页面切换中）' };
      dumpFailed = true;
    } else {
      dumpFailed = false;
      lastValidation = validator(lastState);
      if (lastValidation.valid) {
        return { state: lastState, validation: lastValidation, attempt };
      }
    }
  }
  // Frida hook 已就绪的情况下，dump 持续失败不应直接抛错阻断：
  // 让调用方根据上下文决定是否盲点继续。返回的 state/validation 可空，
  // 调用方用盲点分支接管。
  // 同时：dump 成功但 validator 反复不通过时，也回退到盲点，避免因为
  // 一次结构抽取为空就 throw 把后面整条流程切断。
  if (dumpFailed) {
    // attempt 是循环外的 let，循环跑完时 attempt === attempts + 1。
    return { state: null, validation: null, dumpFailed: true, attempt };
  }
  return { state: lastState, validation: lastValidation, dumpFailed: false, attempt };
}

async function recoverVerifiedHome(client, firstState, maxBacks = 5, budgetCheck = null) {
  let state = firstState;
  for (let backCount = 0; backCount <= maxBacks; backCount++) {
    if (budgetCheck) budgetCheck();
    const validation = validateHome(state);
    if (validation.valid) return { state, validation, back_count: backCount };
    if (backCount === maxBacks) break;
    await client.keyevent(4);
    await sleep(1200);
    if (budgetCheck) budgetCheck();
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
  if (!INPUT_IMAGE || !fs.existsSync(INPUT_IMAGE)) throw new Error('请设置有效的 TEMU_IMAGE 文件路径');

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

  // 全局选图阶段硬上限：脚本必须主动让出，否则会被外层 runNode 在 55s 后直接 taskkill，
  // 报告与异常都会被丢弃。每次 waitForState 轮询前检查；超限立即写报告并同步退出，
  // 避免被外层 taskkill 抢在 fs.writeFileSync 完成之前销毁进程。
  const TRIGGER_BUDGET_MS = Number(process.env.TEMU_TRIGGER_BUDGET_MS || 50000);
  const triggeredAt = Date.now();
  function ensureBudgetOrExit() {
    if (Date.now() - triggeredAt < TRIGGER_BUDGET_MS) return;
    result.error = `图搜选图阶段超过总预算（${TRIGGER_BUDGET_MS}ms）`;
    result.finished_at = new Date().toISOString();
    try { fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    // 同步退出，绕过外层 taskkill。外层 runNode 看到非零退出码立刻回收。
    process.exit(2);
  }

  try {
    // FAST_READY: Temu 已在首页时跳过冷启动；不通过则自动降级到原流程
    let home = null;
    let initialState = null;
    let fastPathUsed = false;
    let fastPathReason = null;
    if (FAST_READY) {
      try {
        const fg = await client.isAppForeground(PACKAGE);
        if (fg.foreground) {
          // 快速路径：Temu 已在前台。先尝试一次 dump（短超时），失败则直接盲点。
          // 云手机在 Frida 干扰下 uiautomator dump 经常拿不到 idle state，
          // 每次 dump 要等满 7-11 秒；连续多轮 dump 会把整张任务拖到分钟级。
          // Temu 已在前台时直接信任坐标即可，商品由 Frida listener 兜底。
          let savedFast = null;
          try {
            savedFast = await saveState(client, '01-initial-state', {
              attempts: 1,
              retryDelayMs: 200,
              dumpTimeoutMs: 2500,
            });
          } catch (_dumpErr) {
            savedFast = null;
          }
          if (savedFast && !savedFast.dump_empty) {
            const validation = validateHome(savedFast);
            if (validation.valid) {
              initialState = savedFast;
              home = { state: savedFast, validation, back_count: 0 };
              fastPathUsed = true;
              fastPathReason = 'Temu 已在首页，跳过 startApp';
            } else {
              fastPathReason = `前台但不通过首页校验：${validation.reason}`;
            }
          } else {
            // dump 失败或空：前台但无法校验 → 盲点模式直接走
            const fallbackHomeState = { name: '01-initial-state', xml: '', nodes: [], xml_path: null, screenshot_path: null, activity: null };
            initialState = fallbackHomeState;
            home = { state: fallbackHomeState, validation: { valid: true, target: null, reason: '前台+dump 不可用，盲点模式' }, back_count: 0 };
            fastPathUsed = true;
            fastPathReason = 'Temu 已在前台但 dump 不可用，进入盲点模式';
          }
        } else {
          fastPathReason = `Temu 不在前台 (resumed=${fg.resumed})`;
        }
      } catch (e) {
        fastPathReason = `快速路径异常：${e.message}`;
      }
    }

    if (!fastPathUsed) {
      result.steps.start = await client.startApp(PACKAGE);
      // 冷启动后轮询首页出现。云手机 + Frida 干扰下 dump 单次 ≈ 8 秒超时，
      // 多轮 dump 必超 50s 预算。这里把 waitForState 缩到 2 轮：首延迟 1.5s +
      // 一次 500ms 重试。dump 失败直接进盲点模式（前台+坐标兜底）。
      try {
        const coldHome = await waitForState(client, '01-initial-state', validateHome, FAST_PRECISE ? 2 : 3, FAST_PRECISE ? 500 : 800, 1500, ensureBudgetOrExit);
        if (coldHome.dumpFailed) {
          // dump 持续空：若 Temu 已在前台，盲点首页图搜图标继续；
          // 若不在前台，再尝试 1 次 dumpsys 兜底，仍失败则让上层回收。
          const fg = await client.isAppForeground(PACKAGE).catch(() => ({ foreground: false }));
          result.steps.cold_dump_failed = { reason: 'dump 持续空，依赖 Frida hook / dumpsys 兜底', foreground: fg.foreground, resumed: fg.resumed };
          if (!fg.foreground) throw new Error('dump 失败且 Temu 不在前台');
          const fallbackHomeState = { name: '01-initial-state', xml: '', nodes: [], xml_path: null, screenshot_path: null, activity: null };
          home = { state: fallbackHomeState, validation: { valid: true, target: null, reason: 'dump 跳过，盲点模式' }, back_count: 0 };
          initialState = fallbackHomeState;
        } else {
          initialState = coldHome.state;
          home = { state: coldHome.state, validation: coldHome.validation, back_count: 0 };
        }
      } catch (e) {
          if (SKIP_RESULT_WAIT) {
            result.steps.no_restart_after_empty_dump = {
              skipped: true,
              reason: 'HTTP 监听已注册，不能重启 Temu 进程，否则 Frida 会话会失效',
              original_error: String((e && (e.message || (e.stack && e.stack.split('\n')[0]))) || e),
            };
            // Frida hook 已加载到 Temu，dump 持续空时直接进入盲点模式。
            // 校验 Temu 是否在前台后跳过 dump 校验直接 tap 首页图搜图标；
            // 这样图搜请求仍能触发，商品由 Frida 的 liveSnapshot 捕获。
            const fg = await client.isAppForeground(PACKAGE).catch(() => ({ foreground: false }));
            if (fg.foreground) {
              const fallbackHomeState = { name: '01-before-back-recovery', xml: '', nodes: [], xml_path: null, screenshot_path: null, activity: null };
              home = { state: fallbackHomeState, validation: { valid: true, target: null, reason: 'cold-dump 失败且 Temu 在前台，进入盲点' }, back_count: 0 };
              initialState = fallbackHomeState;
            } else {
              const fallbackState = initialState || await saveState(client, '01-before-back-recovery', { attempts: 1, retryDelayMs: 200 });
              const recoveredHome = await recoverVerifiedHome(client, fallbackState, 5, ensureBudgetOrExit);
              initialState = recoveredHome.state;
              home = recoveredHome;
            }
          } else {
            // 连续空 dump 通常表示当前 Temu/Accessibility 连接卡住。只有非监听模式才允许重启任务栈。
            await client.shell(`am force-stop ${PACKAGE}; pkill -f "uiautomator dump" 2>/dev/null || true`, { timeout: 5000 }).catch(() => {});
            await sleep(800);
            result.steps.restart_after_empty_dump = await client.startApp(PACKAGE);
            const recoveredHome = await waitForState(client, '01-restarted-state', validateHome, 6, 1200, 3000, ensureBudgetOrExit);
            initialState = recoveredHome.state;
            home = { state: recoveredHome.state, validation: recoveredHome.validation, back_count: 0 };
          }
        }
    }
    result.steps.fast_path = { used: fastPathUsed, reason: fastPathReason };
    result.steps.initial_state = publicState(initialState);
    result.steps.home = publicState(home.state);
    result.steps.home_recovery_back_count = home.back_count;
    result.validation_chain.push({ stage: 'home-camera-entry', ...home.validation, target: undefined });
    ensureBudgetOrExit();
    result.steps.camera_tap = await tapValidatedTarget(client, home.validation, '首页图搜入口');
    ensureBudgetOrExit();

    // menu/picker 都缩短到 1 轮：每次 dump ≈ 8s，多轮必超预算。
    // 若 dump 失败或 validator 不通过，让 menu 走历史坐标盲点（相机入口点击后通常会出菜单或直接进入选择器）。
    const menu = await waitForState(client, '02-image-menu', validateImageMenu, FAST_PRECISE ? 1 : 2, FAST_PRECISE ? 400 : 600, null, ensureBudgetOrExit);
    let menuState = menu;
    if (menu.dumpFailed || !menu.validation || !menu.validation.valid) {
      menuState = { state: { name: '02-image-menu', xml: '', nodes: [], xml_path: null, screenshot_path: null, activity: null }, validation: { valid: true, target: null, reason: menu.dumpFailed ? 'dump 失败，盲点图搜菜单' : `菜单校验未通过：${menu.validation?.reason || '未知'}，盲点` } };
    }
    result.steps.image_menu = publicState(menuState.state);
    result.validation_chain.push({ stage: 'image-search-menu', ...menuState.validation, target: undefined });
    ensureBudgetOrExit();
    result.steps.push = await client.pushFile(INPUT_IMAGE, REMOTE_IMAGE);
    result.steps.scan = await client.scanMedia(REMOTE_IMAGE);
    result.steps.image_published_at = new Date().toISOString();
    result.steps.album_tap = await tapValidatedTarget(client, menuState.validation, '图搜菜单');
    ensureBudgetOrExit();

    const picker = await waitForState(client, '03-system-picker', validatePicker, FAST_PRECISE ? 1 : 2, FAST_PRECISE ? 500 : 800, null, ensureBudgetOrExit);
    let pickerState = picker;
    if (picker.dumpFailed || !picker.validation || !picker.validation.valid) {
      pickerState = { state: { name: '03-system-picker', xml: '', nodes: [], xml_path: null, screenshot_path: null, activity: null }, validation: { valid: true, target: null, reason: picker.dumpFailed ? 'dump 失败，盲点选图' : `选择器校验未通过：${picker.validation?.reason || '未知'}，盲点` } };
    }
    result.steps.system_picker = publicState(pickerState.state);
    result.validation_chain.push({ stage: 'system-image-picker', ...pickerState.validation, target: undefined });
    // 选图后立即交还控制权给 Frida 商品监听器；不再 ensureBudgetOrExit，
    // 否则 50s 硬上限可能吃掉刚刚发起的图搜请求，导致 waitForProducts 永远等不到。
    result.steps.image_tap = await tapValidatedTarget(client, pickerState.validation, '系统图片选择器');

    if (SKIP_RESULT_WAIT) {
      // 商品监听器已在点击前启动。点击即触发图搜请求，这里立即交还控制权，
      // 不再等待结果页渲染或依赖 uiautomator 结构是否可读。
      result.steps.result_wait = { skipped: true, reason: '由 Frida 商品监听器等待本次图搜商品' };
      result.valid_image_search = true;
      result.result_evidence = { trigger: 'system-picker-image-tap', listener: 'frida-product-poll' };
    } else {
      const final = await waitForState(client, '04-validated-result', validateResult, FAST_PRECISE ? 8 : 8, FAST_PRECISE ? 1000 : 2000);
      result.steps.result = publicState(final.state);
      result.validation_chain.push({ stage: 'image-search-result', ...final.validation });
      result.valid_image_search = true;
      result.result_evidence = final.validation.evidence;
    }
    result.finished_at = new Date().toISOString();
  } catch (error) {
    result.error = error.message;
    result.finished_at = new Date().toISOString();
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf8');
    throw error;
  } finally {
    // 查询图只用于本次系统选图。无论图搜、商品导出后续是否成功，都在这里释放云手机相册空间。
    // 可设置 TEMU_KEEP_REMOTE_IMAGE=1 临时保留，便于人工排障。
    if (process.env.TEMU_KEEP_REMOTE_IMAGE !== '1') {
      try {
        await client.removeMediaFile(REMOTE_IMAGE);
        result.steps.remote_image_cleanup = { ok: true, remote_image: REMOTE_IMAGE };
      } catch (cleanupError) {
        result.steps.remote_image_cleanup = { ok: false, error: cleanupError.message, remote_image: REMOTE_IMAGE };
      }
    } else {
      result.steps.remote_image_cleanup = { ok: false, skipped: true, remote_image: REMOTE_IMAGE };
    }
    // finally 在异常路径也会执行，因此在此覆盖写入，确保清理结果可审计。
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf8');
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
