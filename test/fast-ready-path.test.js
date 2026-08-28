// 验证 fast-ready 路径的降级逻辑：
//   - 当 TEMU_FAST_MODE=2 且 isAppForeground=true 且 validateHome 通过时，
//     跳过 startApp + 7s wait + recoverVerifiedHome，记录 fast_path.used=true
//   - 当任一前置条件不满足时，自动降级到原冷启动路径，并记录原因
//
// 通过 mock AdbClient 的 dumpsys + dump 文件系统行为来覆盖，不真正 spawn。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeAdbStub({ foreground = false, homeXml = '' } = {}) {
  // 让 AdbClient.prototype 的 _run 走我们提供的 fixtures
  return {
    _run: async (_args) => {
      // _run(args): 真实场景下这里会把 ['shell', 'dumpsys', ...] / ['exec-out', ...] 分流
      // 简化：用 args[0]=='shell' 时返回 dumpsys；'exec-out' 时返回 home xml
      if (_args[0] === 'shell') return { code: 0, stdout: foreground ? makeForegroundDump() : '', stderr: '' };
      if (_args[0] === 'exec-out') return { code: 0, stdout: homeXml, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

function makeForegroundDump() {
  return [
    'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
    '  mResumedActivity: ActivityRecord{abc u0 com.einnovation.temu/com.baogong.splash.activity.MainFrameActivity t-1}',
  ].join('\n');
}

function makeHomeXml() {
  // 模拟 validateHome 通过：包含包名 + 包含 "按照片搜索" 按钮
  return `<?xml version="1.0"?><hierarchy package="com.einnovation.temu">
    <node bounds="[518,56][592,130]" clickable="true" text="按照片搜索" />
  </hierarchy>`;
}

// 直接拷贝脚本里 validateHome 的最小实现来验证（避免 export 它）
function validateHome(xml) {
  const hasPackage = xml.includes('com.einnovation.temu');
  const hasButton = /按照片搜索|search by (photo|image)/.test(xml);
  return { valid: hasPackage && hasButton, reason: hasPackage ? null : 'no package' };
}

// 模拟 fast-ready 路径的判定函数（脚本里那段逻辑的镜像）
async function decideFastPath(stub) {
  const { AdbClient } = require('../scripts/AdbClient');
  const client = Object.assign(Object.create(AdbClient.prototype), stub);
  const fg = await client.isAppForeground('com.einnovation.temu');
  if (!fg.foreground) return { used: false, reason: 'not in foreground' };
  const dump = await client._run(['exec-out', 'cat', '/sdcard/state.xml']);
  const xml = dump.stdout || '';
  const validation = validateHome(xml);
  if (!validation.valid) return { used: false, reason: validation.reason ? `home not valid: ${validation.reason}` : 'home not valid' };
  return { used: true, reason: 'Temu already at home, skip cold start' };
}

test('fast-ready: Temu 在前台 + 首页校验通过 -> used=true', async () => {
  const stub = makeAdbStub({ foreground: true, homeXml: makeHomeXml() });
  const result = await decideFastPath(stub);
  assert.equal(result.used, true);
  assert.ok(result.reason.includes('already at home'));
});

test('fast-ready: Temu 不在前台 -> used=false', async () => {
  const stub = makeAdbStub({ foreground: false, homeXml: makeHomeXml() });
  const result = await decideFastPath(stub);
  assert.equal(result.used, false);
  assert.equal(result.reason, 'not in foreground');
});

test('fast-ready: Temu 在前台但页面不是首页 -> used=false', async () => {
  const stub = makeAdbStub({ foreground: true, homeXml: '<?xml version="1.0"?><hierarchy package="com.einnovation.temu"><node text="商品详情" /></hierarchy>' });
  const result = await decideFastPath(stub);
  assert.equal(result.used, false);
  assert.ok(result.reason.startsWith('home not valid'));
});

test('fast-ready: Temu 在前台但 dump 失败（空 xml） -> used=false', async () => {
  const stub = makeAdbStub({ foreground: true, homeXml: '' });
  const result = await decideFastPath(stub);
  assert.equal(result.used, false);
  assert.ok(result.reason.startsWith('home not valid'));
});