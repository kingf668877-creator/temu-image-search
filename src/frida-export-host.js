const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const frida = require('frida');

async function compileAgent(agentPath) {
  const projectRoot = path.resolve(__dirname, '..');
  const compiler = require.resolve('frida-compile/dist/cli.js');
  const compiled = path.join(projectRoot, '.temu-export-agent.compiled.js');
  execFileSync(process.execPath, [compiler, agentPath, '-o', compiled], {
    cwd: path.dirname(agentPath),
    stdio: 'pipe',
  });
  return compiled;
}

(async () => {
  const agentPath = process.env.TEMU_EXPORT_AGENT;
  const output = process.env.TEMU_EXPORT_OUTPUT;
  if (!agentPath || !output) throw new Error('缺少 TEMU_EXPORT_AGENT 或 TEMU_EXPORT_OUTPUT');
  const compiled = await compileAgent(agentPath);
  const device = await frida.getDeviceManager().addRemoteDevice(process.env.FRIDA_REMOTE || '127.0.0.1:27042');
  const apps = await device.enumerateApplications({ scope: 'full' });
  const app = apps.find((item) => item.identifier === 'com.einnovation.temu');
  if (!app || !app.pid) throw new Error('Temu 主进程未运行');
  const session = await device.attach(app.pid);
  const script = await session.createScript(fs.readFileSync(compiled, 'utf8'));
  const products = [];
  let meta = null;
  try {
    await new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('商品导出超时')), 60000);
      script.message.connect((message) => {
        if (message.type === 'error') {
          clearTimeout(timer);
          reject(new Error(message.stack || message.description));
          return;
        }
        if (message.type !== 'send') return;
        const payload = message.payload || {};
        if (payload.tag === 'export-start') meta = payload;
        if (payload.tag === 'export-product') products[payload.index] = payload.product;
        if (payload.tag === 'export-error') {
          clearTimeout(timer);
          reject(new Error(payload.error));
        }
        if (payload.tag === 'export-complete') {
          clearTimeout(timer);
          resolve();
        }
      });
      await script.load();
    });
    fs.writeFileSync(output, JSON.stringify({ exportedAt: new Date().toISOString(), meta, products }, null, 2));
    console.log(JSON.stringify({ output, count: products.length }));
  } finally {
    await script.unload().catch(() => {});
    await session.detach().catch(() => {});
    fs.rmSync(compiled, { force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
