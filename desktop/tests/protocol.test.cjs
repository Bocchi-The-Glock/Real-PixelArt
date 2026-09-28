const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { assetPath, assetHandler } = require('../protocol.cjs');
const root = path.resolve(__dirname, '../test-results/protocol-fixture');

test('asset paths stay inside the static bundle', () => {
  assert.equal(assetPath(root, 'pixelart://app/'), path.join(root, 'index.html'));
  assert.equal(assetPath(root, 'pixelart://app/core/grid.js'), path.join(root, 'core/grid.js'));
  for (const url of ['https://app/index.html', 'pixelart://other/index.html',
    'pixelart://user@app/index.html', 'pixelart://app/%2e%2e%2fsecret',
    'pixelart://app/%5csecret', 'pixelart://app/C%3A/secret', 'pixelart://app/a%00b']) {
    assert.equal(assetPath(root, url), null, url);
  }
});

test('handler supports module Worker MIME, HEAD and missing files without path disclosure', async () => {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'index.html'), '<h1>local</h1>');
  await fs.writeFile(path.join(root, 'worker.js'), 'export {};');
  const handle = assetHandler(root);
  const worker = await handle(new Request('pixelart://app/worker.js'));
  assert.equal(worker.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(worker.headers.get('content-length'), '10');
  assert.equal(await worker.text(), 'export {};');
  assert.match(worker.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.doesNotMatch(worker.headers.get('content-security-policy'), /unsafe-eval/);
  const head = await handle(new Request('pixelart://app/', { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await handle(new Request('pixelart://app/missing'))).status, 404);
  assert.equal((await handle(new Request('pixelart://app/%ZZ'))).status, 400);
  assert.equal((await handle(new Request('pixelart://app/', { method: 'POST' }))).status, 405);
});
