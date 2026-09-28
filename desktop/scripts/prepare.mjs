/** Copy the shared static site and add only the native file-save adapter. */
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const built = spawnSync(process.execPath, ['web/build.mjs', '--out', 'build/desktop-web'], { cwd: root, stdio: 'inherit' });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status || 1);
const index = resolve(root, 'build/desktop-web/index.html');
const html = await readFile(index, 'utf8');
await writeFile(index, html.replace('<script src="./app.js"', '<script src="./adapter.js"></script>\n  <script src="./app.js"'));
await copyFile(resolve(root, 'desktop/adapter.js'), resolve(root, 'build/desktop-web/adapter.js'));
console.log('Desktop assets are ready; the algorithm is unchanged.');
