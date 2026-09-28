/** Collect only distributable files; leave all build output intact. */
import { readFile, readdir, mkdir, copyFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {version} = JSON.parse(await readFile(resolve(desktop, 'package.json'), 'utf8'));
const build = resolve(desktop, 'src-tauri/target/release'), output = resolve(desktop, 'release');
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error('Invalid release version');
await mkdir(output, {recursive: true});
const platform = process.platform === 'win32' ? 'win' : 'mac';
const prefix = 'RealPixelArt-' + version + '-' + platform + '-' + process.arch;
const artifacts = [];
async function validateBinary(source) {
  const bytes = await readFile(source);
  if (bytes.includes(Buffer.from('REALPIXELART_SMOKE_DIR'))) {
    throw new Error('Refusing to release a smoke-test binary. Build without the smoke-test feature.');
  }
}
async function copy(source, name) {
  const destination = resolve(output, name);
  await copyFile(source, destination);
  artifacts.push({name, bytes: (await stat(destination)).size});
}
if (process.platform === 'win32') {
  await validateBinary(resolve(build, 'realpixelart.exe'));
  await copy(resolve(build, 'realpixelart.exe'), prefix + '.exe');
  const nsis = resolve(build, 'bundle/nsis');
  const files = await readdir(nsis).catch(error => {if (error.code === 'ENOENT') return []; throw error;});
  for (const file of files.filter(name => name.endsWith('.exe') && name.includes('_' + version + '_'))) {
    await copy(resolve(nsis, file), prefix + '-setup.exe');
  }
} else if (process.platform === 'darwin') {
  const app = resolve(build, 'bundle/macos/RealPixelArt.app');
  const info = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', resolve(app, 'Contents/Info.plist')], {encoding: 'utf8'});
  if (info.error) throw info.error;
  if (info.status !== 0) throw new Error('Cannot read the app executable from Info.plist');
  const executable = info.stdout.trim();
  if (!executable || /[\\/]/.test(executable)) throw new Error('Invalid app executable name');
  await validateBinary(resolve(app, 'Contents/MacOS', executable));
  const zip = resolve(output, prefix + '.zip');
  const zipped = spawnSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], {stdio: 'inherit'});
  if (zipped.error) throw zipped.error;
  if (zipped.status !== 0) throw new Error('Could not archive the app bundle');
  artifacts.push({name: prefix + '.zip', bytes: (await stat(zip)).size});
  const dmg = resolve(build, 'bundle/dmg');
  for (const file of (await readdir(dmg)).filter(name => name.endsWith('.dmg') && name.includes('_' + version + '_'))) {
    await copy(resolve(dmg, file), prefix + '.dmg');
  }
} else {
  throw new Error('Release packaging currently supports Windows and macOS.');
}
console.log(JSON.stringify(artifacts, null, 2));
