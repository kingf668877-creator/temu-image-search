const fs = require('fs');
const { spawn } = require('child_process');

const ADB = process.env.ADB_BIN || 'adb';
const ADB_PORT = process.env.ADB_PORT || '61750';

class AdbClient {
  constructor(options = {}) {
    this.adb = options.adb || ADB;
    this.target = options.target || ('127.0.0.1:' + (options.port || ADB_PORT));
    this.timeout = options.timeout || 20000;
  }

  async _run(args, opts = {}) {
    return new Promise((resolve) => {
      const child = spawn(this.adb, ['-s', this.target, ...args], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish({ code: 124, stdout, stderr: stderr + '\n[timeout]' });
      }, opts.timeout || this.timeout);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => finish({ code: 1, stdout, stderr: stderr + '\n' + error.message }));
      child.on('close', (code) => finish({ code: code || 0, stdout, stderr }));
    });
  }

  async shell(command) {
    const result = await this._run(['shell', command]);
    if (result.code !== 0) throw this.commandError('ADB shell', result);
    return (result.stdout || '') + (result.stderr || '');
  }

  commandError(stage, result) {
    const error = new Error(`${stage}失败：${(result.stderr || result.stdout || `退出码 ${result.code}`).trim()}`);
    error.code = result.code === 124 ? 'ADB_TIMEOUT' : 'ADB_COMMAND_FAILED';
    return error;
  }

  async pushFile(localPath, remotePath) {
    if (!fs.existsSync(localPath)) throw new Error('local file missing: ' + localPath);
    const result = await this._run(['push', localPath, remotePath], { timeout: 60000 });
    if (result.code !== 0 && !result.stdout.includes('file pushed')) throw this.commandError('ADB push', result);
    return (result.stdout || result.stderr).trim();
  }

  async scanMedia(remotePath) {
    return (await this.shell('am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://' + remotePath + ' 2>/dev/null || /system/bin/scanmedia ' + remotePath)).trim();
  }

  async startApp(packageName) {
    const resolved = await this._run(
      ['shell', 'cmd', 'package', 'resolve-activity', '--brief', packageName],
      { timeout: 60000 }
    );
    const output = `${resolved.stdout || ''}\n${resolved.stderr || ''}`;
    const component = output.split(/\r?\n/).map((line) => line.trim())
      .find((line) => line.startsWith(packageName + '/')) ||
      (packageName === 'com.einnovation.temu'
        ? 'com.einnovation.temu/com.baogong.splash.activity.MainFrameActivity'
        : null);
    if (!component) throw new Error('无法解析应用启动 Activity: ' + packageName);
    const result = await this._run(['shell', 'am', 'start', '-n', component], { timeout: 30000 });
    const startOutput = `${result.stdout || ''}${result.stderr || ''}`;
    if (/Error:|Exception/i.test(startOutput)) throw new Error('应用启动失败: ' + startOutput.trim());
    return startOutput.trim();
  }

  async currentActivity() {
    return (await this.shell('dumpsys activity activities 2>/dev/null | grep -E "mResumedActivity|mCurrentFocus" | head -2')).trim();
  }

  async tap(x, y) {
    return (await this.shell('input tap ' + x + ' ' + y)).trim();
  }

  async keyevent(keyCode) {
    return this.shell('input keyevent ' + String(keyCode));
  }

  async screencap(remotePath = '/sdcard/temu-probe.png') {
    await this.shell('screencap -p ' + remotePath);
    return remotePath;
  }

  async readFileBase64(remotePath) {
    const result = await this._run(['exec-out', 'base64', remotePath], { timeout: 60000 });
    if (result.code !== 0) throw this.commandError('读取截图', result);
    return Buffer.from(result.stdout, 'base64');
  }

  async readTextFile(remotePath) {
    const result = await this._run(['exec-out', 'cat', remotePath], { timeout: 60000 });
    if (result.code !== 0) throw this.commandError('读取页面结构', result);
    return result.stdout;
  }
}

module.exports = { AdbClient };
