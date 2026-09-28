// Called after packing/signing and before NSIS embeds the application archive.
// Never patch electron-builder or its node_modules templates.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

module.exports = async event => {
  if (event.targetPresentableName !== 'nsis') return;
  const desktop = path.resolve(__dirname, '..');
  const root = path.join(desktop, 'dist/win-unpacked');
  const files = [];
  const directories = [];
  async function walk(relative = '') {
    const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = path.posix.join(relative, entry.name);
      // These become NSIS literals; reject interpolation, quotes and links.
      if (/[\r\n$"`]/.test(name) || entry.isSymbolicLink()) throw new Error('Unsafe runtime path: ' + name);
      if (entry.isDirectory()) { directories.push(name); await walk(name); }
      else if (entry.isFile()) files.push({ path: name, bytes: fs.statSync(path.join(root, name)).size,
        sha256: await digest(path.join(root, name)) });
      else throw new Error('Unsupported runtime entry: ' + name);
    }
  }
  await walk();
  const version = require('../package.json').version;
  if (!/^[\w.-]+$/.test(version)) throw new Error('Unsafe version');
  const contentHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const id = `realpixelart-${version}-x64-${contentHash.slice(0, 20)}`;
  const lines = [`!define CACHE_ID "${id}"`, '!macro CheckRuntime'];
  for (const dir of directories) lines.push(`  !insertmacro CheckDirectory "${dir.replaceAll('/', '\\')}"`);
  for (const file of files) lines.push(`  !insertmacro CheckFile "${file.path.replaceAll('/', '\\')}" "${file.sha256}"`);
  lines.push('!macroend', '');
  fs.writeFileSync(path.join(desktop, 'dist/runtime-cache.nsh'), lines.join('\n'));
  fs.writeFileSync(path.join(desktop, 'dist/runtime-cache.json'), JSON.stringify({ id, files }, null, 2));
  console.log(`  Runtime cache: ${id} (${files.length} verified files)`);
};
