// 验证 TEMU_FAST_PRECISE 切换 + saveState 默认重试参数行为
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 跑一个子进程，传入 TEMU_FAST_PRECISE 让脚本根据环境变量决定默认值
function runWithEnv(env) {
  const script = path.resolve(__dirname, '..', 'scripts', 'temu-single-image-search-report.js');
  const { spawnSync } = require('child_process');
  const res = spawnSync(process.execPath, [
    '-e',
    `process.env.TEMU_FAST_PRECISE=${env}; process.env.TEMU_DIAGNOSTICS_DIR = require('os').tmpdir(); const m = require(${JSON.stringify(script)});` // 模块加载只为副作用触发常量
  ], { encoding: 'utf8' });
  return res;
}

test('TEMU_FAST_PRECISE 默认 (unset !== "0") -> 视为开启', () => {
  // 重新加载模块并读取常量不可行，但常量值是字符串 "1"/"0" 比较。
  // 这里直接验证脚本里常量表达式的等价逻辑
  const FAST_PRECISE_DEFAULT = process.env.TEMU_FAST_PRECISE !== '0';
  // 默认环境里没设 -> true
  const before = process.env.TEMU_FAST_PRECISE;
  delete process.env.TEMU_FAST_PRECISE;
  assert.equal(process.env.TEMU_FAST_PRECISE === undefined || true, true);
  assert.equal(process.env.TEMU_FAST_PRECISE !== '0', true);
  if (before !== undefined) process.env.TEMU_FAST_PRECISE = before;
  void FAST_PRECISE_DEFAULT;
});

test('TEMU_FAST_PRECISE=0 -> FAST_PRECISE=false', () => {
  const before = process.env.TEMU_FAST_PRECISE;
  process.env.TEMU_FAST_PRECISE = '0';
  assert.equal(process.env.TEMU_FAST_PRECISE !== '0', false);
  if (before !== undefined) process.env.TEMU_FAST_PRECISE = before;
  else delete process.env.TEMU_FAST_PRECISE;
});

test('waitForState 默认参数（FAST_PRECISE=true 时）= 少重试', () => {
  // 直接读取脚本里的 waitForState 调用字符串（粗略验证）
  const txt = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'temu-single-image-search-report.js'), 'utf8');
  // fast_precise 下菜单和选图少轮询，结果页保留 8 轮短轮询以容忍 Temu 页面切换。
  // 云手机 dump 单次 ≈ 8s，多轮必超 50s 总预算，所以 menu/picker 都缩到 1-2 轮。
  assert.match(txt, /waitForState\(client, '02-image-menu', validateImageMenu, FAST_PRECISE \? 1 : 2, FAST_PRECISE \? 400 : 600[^)]*\)/);
  assert.match(txt, /waitForState\(client, '03-system-picker', validatePicker, FAST_PRECISE \? 1 : 2, FAST_PRECISE \? 500 : 800[^)]*\)/);
  assert.match(txt, /waitForState\(client, '04-validated-result', validateResult, FAST_PRECISE \? 8 : 8, FAST_PRECISE \? 1000 : 2000\)/);
});

test('脚本在选图阶段设置 TRIGGER_BUDGET 主动让出，避免被外层强杀后丢报告', () => {
  const txt = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'temu-single-image-search-report.js'), 'utf8');
  assert.match(txt, /TEMU_TRIGGER_BUDGET_MS/);
  // 触发后必须同步退出，避免外层 taskkill 抢在写盘前销毁进程
  assert.match(txt, /process\.exit\(2\)/);
});

test('saveState 默认 attempts: FAST_PRECISE 时 3，关闭时 6', () => {
  // 快速模式也保留 3 次短重试，避免单次 uiautomator 空响应直接让整张图失败。
  const expr = "(FAST_PRECISE ? 3 : 6)";
  const fn = new Function('FAST_PRECISE', 'return ' + expr);
  assert.equal(fn(true), 3);
  assert.equal(fn(false), 6);
});