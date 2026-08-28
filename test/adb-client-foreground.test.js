// 验证 AdbClient.isAppForeground() 在 dumpsys 输出不同格式时都能正确判断
const test = require('node:test');
const assert = require('node:assert/strict');
const { AdbClient } = require('../scripts/AdbClient');

function makeFakeClient(dumpStdout) {
  const fake = {
    _run: async () => ({ code: 0, stdout: dumpStdout, stderr: '' }),
  };
  return Object.assign(Object.create(AdbClient.prototype), fake);
}

test('isAppForeground: dumpsys 命中 mResumedActivity -> foreground=true', async () => {
  const dumpsys = [
    'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
    '  Running activities (most recent first):',
    '    TaskRecord{abcd #1 A=com.einnovation.temu}',
    '    ActivityRecord{abc123 u0 com.einnovation.temu/com.baogong.splash.activity.MainFrameActivity t-1}',
    '  mResumedActivity: ActivityRecord{abc123 u0 com.einnovation.temu/com.baogong.splash.activity.MainFrameActivity t-1}',
    '  mResumed=true mLastReportedResumed=true',
    '',
  ].join('\n');
  const client = makeFakeClient(dumpsys);
  const result = await client.isAppForeground('com.einnovation.temu');
  assert.equal(result.foreground, true);
  assert.ok(result.resumed && result.resumed.includes('MainFrameActivity'));
});

test('isAppForeground: 当前前台不是 Temu -> foreground=false', async () => {
  const dumpsys = [
    'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
    '  mResumedActivity: ActivityRecord{xyz u0 com.android.settings/com.android.settings.Settings t-1}',
    '',
  ].join('\n');
  const client = makeFakeClient(dumpsys);
  const result = await client.isAppForeground('com.einnovation.temu');
  assert.equal(result.foreground, false);
  assert.ok(result.resumed && result.resumed.includes('com.android.settings'));
});

test('isAppForeground: dumpsys 没有 resumed 行（异常状态） -> foreground=false', async () => {
  const dumpsys = [
    'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
    '  No activities',
    '',
  ].join('\n');
  const client = makeFakeClient(dumpsys);
  const result = await client.isAppForeground('com.einnovation.temu');
  assert.equal(result.foreground, false);
  assert.equal(result.resumed, null);
});

test('isAppForeground: dumpsys 空输出时返回安全的 false', async () => {
  const client = makeFakeClient('');
  const result = await client.isAppForeground('com.einnovation.temu');
  assert.equal(result.foreground, false);
  assert.equal(result.resumed, null);
  assert.equal(result.topActivity, null);
});

test('isAppForeground: dumpsys 报错时返回安全的 false', async () => {
  const fake = {
    _run: async () => ({ code: 1, stdout: '', stderr: 'error: closed' }),
  };
  const client = Object.assign(Object.create(AdbClient.prototype), fake);
  const result = await client.isAppForeground('com.einnovation.temu');
  assert.equal(result.foreground, false);
  assert.equal(result.resumed, null);
});