// NSIS portable launchers do not forward the inspector's stdout to Playwright.
// Connect to the unpacked application's local Chromium port instead.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const desktop = path.resolve(__dirname, '..');
const project = path.dirname(desktop);
const version = require('../package.json').version;
const executable = path.join(desktop, `dist/RealPixelArt-Electron-${version}-win-x64.exe`);
const out = path.join(desktop, 'test-results', 'portable-' + Date.now());
const profile = path.join(out, 'profile');
fs.mkdirSync(out, { recursive: true });
const watchdog = setTimeout(() => { console.error('Portable verification timed out'); process.exit(1); }, 180000);

(async () => {
  assert.equal(process.platform, 'win32');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const visible = process.env.PIXELART_SCREENSHOT === '1';
  const child = spawn(executable, ['--remote-debugging-port=0', '--lang=zh-CN',
    '--enable-logging=file', '--log-file=' + path.join(out, 'electron.log'),
    '--user-data-dir=' + profile, ...(visible ? [] : ['--smoke-test'])],
    { cwd: desktop, env, windowsHide: true, stdio: 'ignore' });
  let spawnError; child.on('error', error => { spawnError = error; });
  console.log('Starting single-file EXE:', out);
  let browser;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 90000;
    while (!fs.existsSync(portFile)) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('Portable app did not start');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const [port] = fs.readFileSync(portFile, 'utf8').split('\n');
    console.log('Launcher unpacked; connecting to app...');
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 15000 });
    const page = browser.contexts()[0].pages()[0];
    console.log('Connected; waiting for image engine...');
    await page.waitForFunction(() => ['ready', 'error'].includes(document.querySelector('#status')?.dataset.engineState), null, { timeout: 90000 });
    assert.equal(await page.locator('#status').getAttribute('data-engine-state'), 'ready');
    // Observe original PNG blobs. Canvas readback would round premultiplied alpha
    // and change RGB values, so it cannot verify byte-exact image generation.
    await page.evaluate(() => {
      const create = URL.createObjectURL;
      window.testBlobs = new Map();
      URL.createObjectURL = function(blob) {
        const url = create.call(URL, blob); window.testBlobs.set(url, blob); return url;
      };
    });
    await page.setInputFiles('#file-input', path.join(project, 'input/lastTour.png'));
    console.log('Engine ready; generating lastTour...');
    await page.click('#run');
    await page.waitForFunction(() => !document.querySelector('#download').disabled, null, { timeout: 90000 });
    assert.equal(await page.locator('#metric-grid').textContent(), '331 \u00d7 219');
    const png = await page.evaluate(async () => {
      const blob = window.testBlobs.get(document.querySelector('#result-image').src);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return btoa(binary);
    });
    fs.writeFileSync(path.join(out, 'lastTour.png'), Buffer.from(png, 'base64'));
    if (visible) await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true, timeout: 15000 });
    const verify = `import sys,numpy as np
from pathlib import Path
from PIL import Image
root=Path(sys.argv[1]); sys.path.insert(0,str(root/'src'))
from realpixelart import pixelize
np.testing.assert_array_equal(Image.open(sys.argv[2]).convert('RGBA'),pixelize(root/'input/lastTour.png').image.convert('RGBA'))`;
    execFileSync(process.env.PYTHON || 'python', ['-c', verify, project, path.join(out, 'lastTour.png')], { stdio: 'inherit' });
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ executable,
      portable_bootstrap: 'passed', output_size: [331, 219], pixels_match_python: true }, null, 2));
    console.log('PASS: single-file EXE starts, initializes offline, and generates pixels identical to Python.');
  } finally {
    if (browser) {
      const cdp = await browser.newBrowserCDPSession();
      await Promise.race([cdp.send('Browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]);
      await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    // The launcher exits after Electron and may retire unused older caches.
    const deadline = Date.now() + 15000;
    while (child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (child.exitCode === null) child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
