// Measure the shipped app, with no startup or image-processing code changes.
// Times are observation upper bounds including local CDP connection overhead.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { chromium } = require('playwright');
const desktop = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const out = path.join(desktop, 'test-results', 'startup-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { environment: { os: os.release(), arch: process.arch, cpu: os.cpus()[0].model,
  memory_gib: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version },
  method: 'Two alternating launches per format; first fresh app profile, then reused profile. Persistent runtime cache and OS disk cache are NOT cleared. Use test:cache for first-extraction measurements. UI means DOM available, not exact first-paint time. Times include local debugger connection overhead.',
  samples: [] };
const watchdog = setTimeout(() => { console.error('Startup benchmark timed out'); process.exit(1); }, 240000);

async function measure(kind, run) {
  const exe = kind === 'portable'
    ? path.join(desktop, `dist/RealPixelArt-Electron-${version}-win-x64.exe`)
    : path.join(desktop, 'dist/win-unpacked/RealPixelArt Electron.exe');
  const profile = path.join(out, kind + '-profile');
  const portFile = path.join(profile, 'DevToolsActivePort');
  if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const start = performance.now();
  const child = spawn(exe, ['--smoke-test', '--remote-debugging-port=0', '--user-data-dir=' + profile],
    { cwd: desktop, env, windowsHide: true, stdio: 'ignore' });
  let launchError; child.on('error', error => { launchError = error; });
  let browser;
  try {
    while (!fs.existsSync(portFile)) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || performance.now() - start > 90000) throw new Error(kind + ' did not start');
      await delay(25);
    }
    const processMs = performance.now() - start;
    const [port, socket] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${socket}`, { timeout: 15000 });
    const page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => document.querySelector('#status') && document.querySelector('#run'));
    const uiMs = performance.now() - start;
    await page.waitForFunction(() => ['ready', 'error'].includes(document.querySelector('#status').dataset.engineState), null, { timeout: 90000 });
    const engineMs = performance.now() - start;
    if (await page.locator('#status').getAttribute('data-engine-state') !== 'ready') throw new Error(await page.locator('#status').textContent());
    const manifest = await page.evaluate(async () => (await fetch('./core-manifest.json')).json());
    const sample = { kind, run, profile: run === 1 ? 'fresh' : 'reused',
      process_available_ms: Math.round(processMs), ui_available_ms: Math.round(uiMs),
      engine_ready_ms: Math.round(engineMs), core_sha256: manifest.bundle_sha256 };
    report.samples.push(sample);
    fs.writeFileSync(path.join(out, 'startup.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(sample));
  } finally {
    if (browser?.isConnected()) {
      const cdp = await browser.newBrowserCDPSession();
      await Promise.race([cdp.send('Browser.close').catch(() => {}), delay(2000)]);
      await Promise.race([browser.close(), delay(2000)]);
    }
    const deadline = Date.now() + 15000;
    while (child.exitCode === null && Date.now() < deadline) await delay(100);
    if (child.exitCode === null) { child.kill(); throw new Error(kind + ' did not close cleanly'); }
  }
}

(async () => {
  for (let run = 1; run <= 2; run++) for (const kind of ['portable', 'folder']) await measure(kind, run);
  if (new Set(report.samples.map(s => s.core_sha256)).size !== 1) throw new Error('Core versions differ');
  console.log('Startup report:', path.join(out, 'startup.json'));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
