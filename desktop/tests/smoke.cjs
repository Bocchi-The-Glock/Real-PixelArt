// Exercise the actual Electron runtime, not an HTTP approximation of the website.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const desktop = path.resolve(__dirname, '..');
const project = path.dirname(desktop);
const packaged = process.argv.includes('--packaged');
const out = path.join(desktop, 'test-results', (packaged ? 'packaged-' : 'development-') + Date.now());
fs.mkdirSync(out, { recursive: true });
const cases = [
  { name: 'lastTour.png', config: {} },
  { name: 'hollow-knight-sprite.png', config: {} },
  { name: 'exec-c6a62802-b08a-44b3-b383-0c3ecfaa2c3a.png', config: { colors: 8 } },
];
let executablePath = process.env.PIXELART_EXECUTABLE || require('electron');
if (packaged && !process.env.PIXELART_EXECUTABLE) {
  executablePath = process.platform === 'win32'
    ? path.join(desktop, 'dist/win-unpacked/RealPixelArt.exe')
    : path.join(desktop, process.arch === 'arm64' ? 'dist/mac-arm64' : 'dist/mac',
                'RealPixelArt.app/Contents/MacOS/RealPixelArt');
}

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath, cwd: desktop,
    args: [...(packaged ? [] : [desktop]), '--smoke-test', '--lang=zh-CN',
      '--user-data-dir=' + path.join(out, 'profile-' + Date.now())],
    env, timeout: 60000 });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    const errors = [], remote = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('request', r => { if (/^https?:/.test(r.url())) remote.push(r.url()); });
    await page.waitForFunction(() => ['ready', 'error'].includes(document.querySelector('#status')?.dataset.engineState), null, { timeout: 90000 });
    assert.equal(await page.locator('#status').getAttribute('data-engine-state'), 'ready', await page.locator('#status').textContent());
    assert.equal(await page.title(), 'RealPixelArt');
    assert.equal(await page.locator('.brand').innerText(), 'Real Pixel Art');
    assert.equal(await app.evaluate(({ app }) => app.getName()), 'RealPixelArt');
    assert.equal(await page.evaluate(() => isSecureContext && Boolean(crypto.subtle)), true);
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false);
    // Click real links; intercept only the OS browser launch to keep tests offline.
    const repository = 'https://github.com/Bocchi-The-Glock/Real-PixelArt';
    await app.evaluate(({ shell }) => {
      globalThis.testRepositoryLinks = [];
      shell.openExternal = async address => { globalThis.testRepositoryLinks.push(address); };
    });
    for (const selector of ['.brand', '#github-header-link', '#github-link']) {
      assert.equal(await page.locator(selector).getAttribute('href'), repository);
      await page.click(selector);
    }
    await page.locator('#github-link').focus(); await page.keyboard.press('Enter');
    const linkDeadline = Date.now() + 5000;
    while (await app.evaluate(() => globalThis.testRepositoryLinks.length) < 4) {
      if (Date.now() > linkDeadline) throw new Error('Repository click did not reach the system browser');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await page.evaluate(() => window.open('https://github.com.example.org/Bocchi-The-Glock/Real-PixelArt'));
    const repositoryLinks = await app.evaluate(() => globalThis.testRepositoryLinks);
    assert.deepEqual(repositoryLinks, [repository, repository, repository, repository]);
    assert.equal(app.windows().length, 1); assert.equal(page.url(), 'pixelart://app/');
    console.log('PASS: RealPixelArt branding and all three repository links, including keyboard navigation.');
    const measured = [];
    for (const [i, item] of cases.entries()) {
      const input = fs.readFileSync(path.join(project, 'input', item.name)).toString('base64');
      const result = await page.evaluate(async ({ input, item }) => {
        const worker = new Worker('./worker.js', { type: 'module' });
        try {
          const output = await new Promise((resolve, reject) => {
            worker.onmessage = ({ data }) => {
              if (data.type === 'result') resolve(data);
              if (data.type === 'error') reject(new Error(data.message));
            };
            worker.onerror = event => reject(new Error(event.message));
            const bytes = Uint8Array.from(atob(input), c => c.charCodeAt(0)).buffer;
            worker.postMessage({ type: 'process', id: 1, bytes, request: { ...item, debug: false } }, [bytes]);
          });
          const view = new Uint8Array(output.output); let binary = '';
          for (let j = 0; j < view.length; j += 32768) binary += String.fromCharCode(...view.subarray(j, j + 32768));
          return { png: btoa(binary), meta: output.meta };
        } finally { worker.terminate(); }
      }, { input, item });
      fs.writeFileSync(path.join(out, `case-${i}.png`), Buffer.from(result.png, 'base64'));
      measured.push({ ...item, grid: result.meta.grid, confidence: result.meta.confidence });
      console.log('Electron:', item.name, result.meta.grid.output_size);
    }
    // Use real upload / Generate / export controls and the native download handler.
    console.log('Checking upload and native downloads...');
    await app.evaluate(({ session }, out) => {
      globalThis.testDownloads = [];
      session.defaultSession.on('will-download', (_event, item) => {
        const target = out + '/' + item.getFilename();
        const options = item.getSaveDialogOptions();
        item.setSavePath(target); // Test destination replaces only the interactive save dialog.
        item.once('done', (_event, state) => globalThis.testDownloads.push({ target, state, options }));
      });
    }, out);
    await page.evaluate(() => {
      window.engineRequests = []; window.colorReplies = [];
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (data, ...rest) {
        window.engineRequests.push(data.type);
        if (!this.testObserved) {
          this.testObserved = true;
          this.addEventListener('message', ({ data: response }) => {
            if (response.type === 'recolor') window.colorReplies.push(response.meta);
          });
        }
        return send.call(this, data, ...rest);
      };
    });
    await page.setInputFiles('#file-input', path.join(project, 'input/lastTour.png'));
    console.log('Uploaded lastTour; generating...');
    await page.click('#run');
    await page.waitForFunction(() => !document.querySelector('#download').disabled, null, { timeout: 90000 });
    assert.equal(await page.locator('#metric-grid').textContent(), '331 × 219');
    assert.equal(await page.locator('#result-size').textContent(), '331 × 219');
    // Real color controls must use the cached unlimited output, never rerun detection.
    await page.locator('#colors').focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => window.colorReplies.length >= 1);
    assert.equal(await page.evaluate(() => window.colorReplies.at(-1).color_processing.output_colors), 2);
    await page.locator('#colors-number').fill('8'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.colorReplies.length >= 2);
    assert.equal(await page.evaluate(() => window.colorReplies.at(-1).color_processing.output_colors), 8);
    await page.locator('#color-mode').selectOption('rgb');
    await page.waitForFunction(() => window.colorReplies.length >= 3);
    await page.locator('#use-palette').check();
    await page.waitForFunction(() => window.colorReplies.length >= 4);
    await page.locator('#palette').selectOption('MARD24');
    await page.waitForFunction(() => window.colorReplies.length >= 5);
    assert.equal(await page.evaluate(() => window.colorReplies.at(-1).color_processing.palette), 'MARD24');
    await page.locator('#use-palette').uncheck();
    await page.waitForFunction(() => window.colorReplies.length >= 6);
    await page.locator('#colors').focus(); await page.keyboard.press('Home');
    await page.waitForFunction(() => window.colorReplies.length >= 7);
    assert.equal(await page.evaluate(() => window.colorReplies.at(-1).color_processing.applied), false);
    assert.equal(await page.evaluate(() => window.engineRequests.filter(type => type === 'process').length), 1);
    const preview = await page.locator('#result-image').getAttribute('src');
    for (const scale of [2, 16, 1]) {
      await page.locator('#scale').fill(String(scale));
      assert.equal(await page.locator('#result-size').textContent(),
        '331 × 219' + (scale === 1 ? '' : ` (${331 * scale} × ${219 * scale})`));
      assert.equal(await page.locator('#result-image').getAttribute('src'), preview);
      assert.equal(await page.locator('#download').isEnabled(), true);
    }
    await page.locator('#scale').fill('3');
    assert.equal(await page.locator('#result-size').textContent(), '331 × 219 (993 × 657)');
    console.log('Exporting PNG and ZIP...');
    await page.click('#download');
    await page.waitForFunction(() => !document.querySelector('#download').disabled);
    await page.click('#download-debug');
    const deadline = Date.now() + 30000;
    while (await app.evaluate(() => globalThis.testDownloads.length) < 2) {
      if (Date.now() > deadline) throw new Error('Native downloads did not finish');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const downloads = await app.evaluate(() => globalThis.testDownloads);
    fs.writeFileSync(path.join(out, 'downloads.json'), JSON.stringify(downloads, null, 2));
    assert.ok(downloads.every(d => d.state === 'completed'), JSON.stringify(downloads));
    assert.deepEqual(downloads.map(d => d.options.filters[0].extensions[0]).sort(), ['png', 'zip']);
    console.log('Downloads completed; comparing with Python...');
    if (process.env.PIXELART_SCREENSHOT === '1') {
      // Hidden native windows have no compositor frame on some Windows desktops.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
      await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true, timeout: 15000 });
    }
    assert.deepEqual(errors, []); assert.deepEqual(remote, []);
    fs.writeFileSync(path.join(out, 'cases.json'), JSON.stringify(measured));
    const verify = `
import sys,json,zipfile
from pathlib import Path
import numpy as np
from PIL import Image
root=Path(sys.argv[1]); out=Path(sys.argv[2]); sys.path.insert(0,str(root/'src'))
from realpixelart import pixelize,Config
for i,c in enumerate(json.loads((out/'cases.json').read_text())):
 r=pixelize(root/'input'/c['name'],Config(**c['config']))
 np.testing.assert_array_equal(Image.open(out/f'case-{i}.png').convert('RGBA'),r.image.convert('RGBA'))
 assert c['grid'].keys()==r.grid.keys()
 for key,value in r.grid.items():
  if isinstance(value,float):
   np.testing.assert_allclose(c['grid'][key],value,rtol=0,atol=1e-6,err_msg=key)
  else:
   assert c['grid'][key]==value,key
r=pixelize(root/'input/lastTour.png')
np.testing.assert_array_equal(Image.open(out/'lastTour.png').convert('RGBA'),r.image.resize((993,657),Image.Resampling.NEAREST).convert('RGBA'))
with zipfile.ZipFile(out/'lastTour_debug.zip') as z:
 info=json.loads(z.read('output/debug/lastTour/info.json'))
 assert info['grid']['output_size']==[331,219]
 assert len([p for p in z.namelist() if p.endswith('.png')])==5
 assert info['diagnostics']['color_processing']['applied'] is False
print('PASS: output pixels and grid match Python; native 3x PNG and diagnostic ZIP verified.')
`;
    console.log(execFileSync(process.env.PYTHON || 'python', ['-c', verify, project, out], { encoding: 'utf8' }));
    // This input produces an estimated-grid warning in metadata, without a banner in the UI.
    await page.setInputFiles('#file-input', path.join(project, 'input', cases[2].name));
    assert.equal(await page.locator('#result-size').textContent(), '—');
    await page.click('#run');
    await page.waitForFunction(() => !document.querySelector('#download').disabled, null, { timeout: 90000 });
    assert.match(await page.locator('#status').textContent(), /已按方正边缘估算网格/);
    assert.equal(await page.locator('#warnings, .warning-box').count(), 0);
    await page.click('#language-toggle');
    assert.equal(await page.locator('#warnings, .warning-box').count(), 0);
    await page.click('#clear-file');
    assert.equal(await page.locator('#result-size').textContent(), '—');
    assert.deepEqual(errors, []);
    console.log('PASS: export size labels update without regeneration; estimated-grid banner removed.');
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ packaged,
      executable: executablePath, cases: measured, downloads, repository_links: repositoryLinks, page_errors: errors, remote_requests: remote,
      runtime: await app.evaluate(() => process.versions) }, null, 2));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exit(1); });
