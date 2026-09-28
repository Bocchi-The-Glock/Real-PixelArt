// Exercise the shipped single EXE (not a mocked cache manager). Run on Windows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const desktop = path.resolve(__dirname, '..');
const manifest = require('../dist/runtime-cache.json');
const version = require('../package.json').version;
const executable = path.join(desktop, `dist/RealPixelArt-${version}-win-x64.exe`);
const root = path.join(process.env.LOCALAPPDATA, 'RealPixelArt/Runtime');
const cache = path.join(root, manifest.id);
assert.match(manifest.id, /^realpixelart-[\w.-]+-x64-[a-f0-9]{20}$/);
assert.equal(path.dirname(cache), path.resolve(root));
const out = path.join(desktop, 'test-results', 'runtime-cache-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const profile = path.join(out, 'profile');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { environment: { os: os.release(), cpu: os.cpus()[0].model, node: process.version },
  executable, cache, bytes: fs.statSync(executable).size,
  method: 'Actual shipped EXE; same app profile, OS disk cache not cleared. DOM/engine times include local CDP overhead.', samples: [] };

function safeRemove(target) {
  assert.equal(path.dirname(path.resolve(target)), path.resolve(root));
  assert.ok(path.basename(target).startsWith('realpixelart-'));
  // Node rm removes symlinks themselves; it does not follow directory junctions.
  fs.rmSync(target, { recursive: true, force: true });
}
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
function start() {
  const child = spawn(executable, ['--smoke-test', '--remote-debugging-port=0', '--user-data-dir=' + profile],
    { cwd: desktop, env, windowsHide: true, stdio: 'ignore' });
  child.on('error', error => { child.launchError = error; });
  return child;
}
async function exited(child) {
  const deadline = Date.now() + 20000;
  while (child.exitCode === null && Date.now() < deadline) await delay(50);
  assert.notEqual(child.exitCode, null, 'Launcher must exit without keeping the app alive');
  assert.equal(child.exitCode, 0);
}
async function launch(name, check) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const started = performance.now();
  const child = start();
  let browser;
  try {
    while (!fs.existsSync(portFile)) {
      if (child.launchError) throw child.launchError;
      assert.equal(child.exitCode, null, 'Launcher unexpectedly exited');
      assert.ok(performance.now() - started < 90000, 'Launcher did not start within 90 seconds');
      await delay(25);
    }
    const [port, socket] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${socket}`);
    const page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => document.querySelector('#status') && document.querySelector('#run'));
    const ui = performance.now() - started;
    await page.waitForFunction(() => ['ready', 'error'].includes(document.querySelector('#status').dataset.engineState), null, { timeout: 90000 });
    assert.equal(await page.locator('#status').getAttribute('data-engine-state'), 'ready');
    const engine = performance.now() - started;
    assert.equal(fs.readFileSync(path.join(cache, '.app-started'), 'utf8'), manifest.id);
    if (check) await check(page);
    report.samples.push({ name, ui_available_ms: Math.round(ui), engine_ready_ms: Math.round(engine) });
    console.log(JSON.stringify(report.samples.at(-1)));
  } finally {
    if (browser?.isConnected()) {
      const cdp = await browser.newBrowserCDPSession();
      await Promise.race([cdp.send('Browser.close').catch(() => {}), delay(2000)]);
      await Promise.race([browser.close(), delay(2000)]);
    }
    if (!browser) child.kill();
    else await exited(child);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify(report, null, 2));
  }
}

(async () => {
  assert.equal(process.platform, 'win32');
  // This ID was generated for the current build only; no other cache is removed.
  safeRemove(cache);
  await launch('first extraction');
  const stamp = fs.statSync(path.join(cache, '.runtime-cache.ini')).mtimeMs;
  const appStamp = fs.statSync(path.join(cache, 'RealPixelArt.exe')).mtimeMs;
  await launch('cache reused', async () => {
    assert.equal(fs.statSync(path.join(cache, '.runtime-cache.ini')).mtimeMs, stamp);
    assert.equal(fs.statSync(path.join(cache, 'RealPixelArt.exe')).mtimeMs, appStamp);
    // A second double-click must focus the original app and exit, never wait for
    // its lifetime or remove files used by the original running process.
    const second = start();
    await exited(second);
    assert.ok(fs.existsSync(path.join(cache, 'RealPixelArt.exe')));
  });
  const file = path.join(cache, 'resources/web/index.html');
  const expected = manifest.files.find(f => f.path === 'resources/web/index.html').sha256;
  const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  await launch('same-size corruption repaired');
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected);
  fs.unlinkSync(path.join(cache, 'resources/web/core/pipeline.js'));
  await launch('missing engine file repaired');
  assert.ok(fs.existsSync(path.join(cache, 'resources/web/core/pipeline.js')));

  // Distinguish owned obsolete caches from unrelated files before deleting.
  const old = path.join(root, 'realpixelart-0.0.0-x64-' + '0'.repeat(20));
  const unknown = path.join(root, 'realpixelart-test-unowned-x64-' + '0'.repeat(20));
  const linked = path.join(root, 'realpixelart-test-junction-x64-' + '0'.repeat(20));
  const held = path.join(root, 'realpixelart-test-in-use-x64-' + '0'.repeat(20));
  assert.ok([old, unknown, linked, held].every(p => !fs.existsSync(p)), 'Fixture names already exist');
  fs.mkdirSync(old); fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(old, '.runtime-cache.ini'), '[cache]\r\nowner=RealPixelArt.Runtime.v1\r\nid=' + path.basename(old) + '\r\n');
  fs.writeFileSync(path.join(old, '.in-use'), '');
  fs.writeFileSync(path.join(unknown, 'keep.txt'), 'unrelated');
  for (const dir of [linked, held]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.runtime-cache.ini'), '[cache]\r\nowner=RealPixelArt.Runtime.v1\r\nid=' + path.basename(dir) + '\r\n');
    fs.writeFileSync(path.join(dir, '.in-use'), '');
  }
  const protectedFolder = path.join(out, 'unrelated-images');
  fs.mkdirSync(protectedFolder);
  fs.writeFileSync(path.join(protectedFolder, 'keep.txt'), 'user image sentinel');
  fs.symlinkSync(protectedFolder, path.join(linked, 'redirect'), 'junction');
  // Match the Win32 shared read lease held by a running bootstrap. Node's fs.open
  // allows FILE_SHARE_DELETE, so it cannot model this Windows lock correctly.
  const locker = spawn(process.env.PYTHON || 'python', ['-u', '-c', `import ctypes,sys
from ctypes import wintypes as w
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,w.LPVOID,w.DWORD,w.DWORD,w.HANDLE]
k.CreateFileW.restype=w.HANDLE
h=k.CreateFileW(sys.argv[1],0x80000000,1,None,3,0x80,None)
assert h != w.HANDLE(-1).value, ctypes.get_last_error()
print('locked',flush=True)
sys.stdin.read()
k.CloseHandle.argtypes=[w.HANDLE]
k.CloseHandle(h)`, path.join(held, '.in-use')], { windowsHide: true });
  await new Promise((resolve, reject) => {
    locker.on('error', reject);
    locker.stdout.once('data', data => data.toString().includes('locked') ? resolve() : reject(new Error(String(data))));
    locker.once('exit', code => { if (code) reject(new Error('Lease helper failed')); });
  });
  try {
    await launch('old cache cleanup');
    assert.ok(!fs.existsSync(old), 'Owned obsolete cache should be removed');
    assert.equal(fs.readFileSync(path.join(unknown, 'keep.txt'), 'utf8'), 'unrelated');
    assert.ok(fs.existsSync(held), 'Running old runtime must be retained');
    assert.ok(fs.existsSync(linked), 'Cleanup must reject directory junctions');
    assert.equal(fs.readFileSync(path.join(protectedFolder, 'keep.txt'), 'utf8'), 'user image sentinel');
    locker.stdin.end(); await exited(locker);
    await launch('released old cache cleanup');
    assert.ok(!fs.existsSync(held), 'Unused old runtime should now be removed');
  } finally {
    locker.stdin.end();
    if (locker.exitCode === null) await exited(locker);
    for (const dir of [old, unknown, linked, held]) safeRemove(dir);
  }
  safeRemove(cache);
  await launch('deleted cache restored');
  await launch('restored cache reused');
  report.passed = ['first extraction', 'reuse without rewriting', 'repeated double click',
    'same-size corruption', 'missing file', 'owned old-cache cleanup', 'unrelated files retained',
    'in-use old caches retained', 'directory junctions rejected', 'deleted cache restoration'];
  fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify(report, null, 2));
  console.log('PASS:', path.join(out, 'verification.json'));
})().catch(error => { console.error(error); process.exitCode = 1; });
