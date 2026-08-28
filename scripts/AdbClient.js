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
      const timeoutMs = opts.timeout || this.timeout;
      const timer = setTimeout(() => {
        // adb 在 Windows 上偶发残留 server/子进程；杀完整树防止后续图搜竞争同一隧道。
        try {
          if (process.platform === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
          } else {
            child.kill('SIGKILL');
          }
        } catch {}
        finish({ code: 124, stdout, stderr: stderr + `\n[timeout after ${timeoutMs}ms]` });
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => finish({ code: 1, stdout, stderr: stderr + '\n' + error.message }));
      child.on('close', (code) => finish({ code: code || 0, stdout, stderr }));
    });
  }

  async shell(command, opts = {}) {
    const result = await this._run(['shell', command], opts);
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
    return (await this.shell(
      'am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://' + remotePath + ' 2>/dev/null || /system/bin/scanmedia ' + remotePath,
      { timeout: 12000 }
    )).trim();
  }

  async removeMediaFile(remotePath) {
    // 删除临时查询图后再次触发扫描，避免相册保留失效缩略图或媒体索引记录。
    const escapedPath = String(remotePath).replace(/'/g, "'\\''");
    const output = await this.shell(
      `rm -f '${escapedPath}'; am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://'${escapedPath}' 2>/dev/null || true`,
      { timeout: 10000 }
    );
    return output.trim();
  }

  async startApp(packageName) {
    // Temu 的主 Activity 是稳定已知值。隧道异常时不能先等 60 秒 resolve-activity，
    // 否则每张图片都会在真正触发图搜前无限阻塞。
    const knownComponent = packageName === 'com.einnovation.temu'
      ? 'com.einnovation.temu/com.baogong.splash.activity.MainFrameActivity'
      : null;
    const resolved = await this._run(
      ['shell', 'cmd', 'package', 'resolve-activity', '--brief', packageName],
      { timeout: 10000 }
    );
    const output = `${resolved.stdout || ''}\n${resolved.stderr || ''}`;
    const component = output.split(/\r?\n/).map((line) => line.trim())
      .find((line) => line.startsWith(packageName + '/')) || knownComponent;
    if (!component) throw this.commandError('解析应用启动 Activity', resolved);
    const result = await this._run(['shell', 'am', 'start', '-n', component], { timeout: 15000 });
    const startOutput = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.code !== 0) throw this.commandError('应用启动', result);
    if (/Error:|Exception/i.test(startOutput)) throw new Error('应用启动失败: ' + startOutput.trim());
    return startOutput.trim();
  }

  async currentActivity() {
    return (await this.shell('dumpsys activity activities 2>/dev/null | grep -E "mResumedActivity|mCurrentFocus" | head -2')).trim();
  }

  // 探测 Temu 是否在前台并位于顶层 Activity（用于快速路径跳过 startApp）
  async isAppForeground(packageName = process.env.TEMU_PACKAGE || 'com.einnovation.temu') {
    // 部分系统不输出 mResumedActivity，只输出 topResumedActivity / mCurrentFocus，
    // 所以三种信号都抓，任一行出现 <pkg>/<activity> 且属于目标包即视为前台
    let blob;
    try {
      blob = await this.shell(
        'dumpsys activity activities 2>/dev/null | grep -E "mResumedActivity|topResumedActivity|mCurrentFocus|mFocusedApp" | head -6'
      );
    } catch {
      return { foreground: false, resumed: null, topActivity: null };
    }
    if (!blob.trim()) return { foreground: false, resumed: null, topActivity: null };
    function pickComponent(line) {
      if (!line) return null;
      const match = line.match(/([a-zA-Z][\w.]*\/[\w.$]+)/);
      return match ? match[1] : null;
    }
    const lines = blob.split('\n');
    const resumedLine = lines.find((line) => /mResumedActivity/.test(line));
    const topLine = lines.find((line) => /topResumedActivity/.test(line));
    const focusLine = lines.find((line) => /mCurrentFocus|mFocusedApp/.test(line));
    const resumed = pickComponent(resumedLine);
    const top = pickComponent(topLine);
    const focused = pickComponent(focusLine);
    const primary = resumed || top || focused;
    const foreground = Boolean(primary && primary.startsWith(packageName + '/'));
    return { foreground, resumed: primary, topActivity: top || focused };
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

  async readTextFile(remotePath, options = {}) {
    const result = await this._run(['exec-out', 'cat', remotePath], { timeout: options.timeout || 60000 });
    if (result.code !== 0) throw this.commandError('读取页面结构', result);
    return result.stdout;
  }
}

module.exports = { AdbClient };
