import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(new URL('../adapter.js', import.meta.url), 'utf8');
function harness({missing = [], failSave = false} = {}) {
  const listeners = {}, calls = [], alerts = [];
  const context = {
    Uint8Array, console,
    document: {addEventListener: (name, fn) => {listeners[name] = fn;}},
    window: {
      addEventListener: (name, fn) => {listeners[name] = fn;},
      alert: message => alerts.push(message),
      __TAURI__: {core: {invoke: async (name, args) => {
        calls.push({name, args}); if (failSave) throw new Error('Disk full'); return true;
      }}},
    },
    fetch: async () => ({arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer}),
  };
  for (const name of ['Worker', 'OffscreenCanvas', 'CompressionStream', 'DecompressionStream', 'createImageBitmap']) {
    if (!missing.includes(name)) context[name] = function () {};
  }
  runInNewContext(source, context);
  return {listeners, calls, alerts};
}
test('PNG download uses the native save command without changing bytes', async () => {
  const h = harness(), link = {href: 'blob:local/image', download: 'pixel.png', dataset: {}};
  let prevented = false;
  await h.listeners.click({target: {closest: () => link}, preventDefault() {prevented = true;}});
  assert.equal(prevented, true);
  assert.equal(h.calls[0].name, 'save_export');
  assert.deepEqual(Array.from(h.calls[0].args.bytes), [137, 80, 78, 71]);
  assert.equal(h.calls[0].args.name, 'pixel.png');
  assert.equal(link.dataset.saving, undefined);
});
test('ordinary external links are left to the window navigation handler', async () => {
  const h = harness();
  await h.listeners.click({target: {closest: () => ({href: 'https://github.com', dataset: {}})}});
  assert.equal(h.calls.length, 0);
});
test('failed save allows retry and reports the failure', async () => {
  const h = harness({failSave: true}), link = {href: 'blob:image', download: 'a.png', dataset: {}};
  await h.listeners.click({target: {closest: () => link}, preventDefault() {}});
  assert.equal(h.alerts.length, 1); assert.equal(link.dataset.saving, undefined);
});
test('missing browser APIs open runtime guidance; supported browsers do not', async () => {
  const h = harness({missing: ['OffscreenCanvas', 'CompressionStream']});
  h.listeners.DOMContentLoaded();
  assert.equal(h.calls[0].name, 'runtime_problem');
  assert.equal(h.calls[0].args.detail, 'OffscreenCanvas, CompressionStream');
  const ready = harness(); ready.listeners.DOMContentLoaded();
  assert.equal(ready.calls.length, 0);
});
test('Tauri frontend shares every algorithm and visual asset with the website', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../web/core-manifest.json', import.meta.url), 'utf8'));
  for (const name of Object.keys(manifest.files).filter(name => name !== 'index.html')) {
    assert.deepEqual(await readFile(new URL('../../web/' + name, import.meta.url)),
      await readFile(new URL('../../build/desktop-web/' + name, import.meta.url)), name);
  }
  const index = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
  const desktop = await readFile(new URL('../../build/desktop-web/index.html', import.meta.url), 'utf8');
  assert.ok(desktop.includes('adapter.js'), 'Desktop adapter must be injected');
  assert.equal(desktop.replace('<script src="./adapter.js"></script>\n  ', ''), index);
});

test('HTTP and HTTPS links are authorized without a domain restriction', async () => {
  const capability = JSON.parse(await readFile(new URL('../src-tauri/capabilities/main.json', import.meta.url), 'utf8'));
  const permission = capability.permissions.find(item => item.identifier === 'opener:allow-open-url');
  assert.ok(permission);
  assert.deepEqual(permission.allow, [{url: 'https://*'}, {url: 'http://*'}]);
});
