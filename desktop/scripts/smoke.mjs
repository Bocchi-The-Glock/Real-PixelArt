/** Launch a test-only native build; exercise the real WebView and compare PNGs. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { decodePng, encodePng, unzipStored } from '../../web/core/tools.js';
import { pixelize } from '../../web/core/pipeline.js';
import { runNative } from './native-test.mjs';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = dirname(desktop), output = resolve(desktop, 'test-results/native');
await mkdir(output, {recursive: true});
const cases = [
  {name: 'lastTour.png', config: {}},
  {name: 'hollow-knight-sprite.png', config: {}},
  {name: 'exec-c6a62802-b08a-44b3-b383-0c3ecfaa2c3a.png', config: {colors: 8}},
];
const inputs = await Promise.all(cases.map(async item => ({...item,
  input: (await readFile(resolve(root, 'input', item.name))).toString('base64')})));
await writeFile(resolve(output, 'input.json'), JSON.stringify(inputs));
await copyFile(resolve(desktop, 'tests/runtime.js'), resolve(output, 'runtime.js'));
const executable = process.env.REALPIXELART_TEST_EXE ||
  resolve(desktop, 'src-tauri/target/debug/realpixelart' + (process.platform === 'win32' ? '.exe' : ''));
const runtime = spawnSync(executable, ['--check-runtime'], {encoding: 'utf8', windowsHide: true});
assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
assert.equal(JSON.parse(runtime.stdout).available, true);
if (process.platform === 'win32') {
  const empty = resolve(output, 'empty-runtime');
  await mkdir(empty, {recursive: true});
  const missing = spawnSync(executable, ['--check-runtime'], {encoding: 'utf8', windowsHide: true,
    env: {...process.env, WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: empty}});
  assert.equal(missing.status, 2, missing.stderr || missing.stdout);
  assert.equal(JSON.parse(missing.stdout).available, false);
}
for (const name of ['report.json', 'progress.log', 'native.log']) {
  await rm(resolve(output, name), {force: true});
}
const started = performance.now();
const report = await runNative(executable, {cwd: desktop, output,
  env: {REALPIXELART_SMOKE_DIR: output, REALPIXELART_SMOKE_STARTED: String(Date.now())}});
const libraries = JSON.parse(await readFile(resolve(root, 'web/core/palettes.json'), 'utf8'));
for (const [index, item] of cases.entries()) {
  const input = await decodePng(await readFile(resolve(root, 'input', item.name)));
  const expected = pixelize(input, item.config, libraries);
  const actual = await decodePng(await readFile(resolve(output, 'case-' + index + '.png')));
  assert.equal(actual.width, expected.image.width);
  assert.equal(actual.height, expected.image.height);
  assert.deepEqual(actual.data, expected.image.data, item.name + ': native pixels differ');
  const grid = report.outputs[index].grid;
  assert.deepEqual(Object.keys(grid).sort(), Object.keys(expected.grid).sort());
  for (const [key, value] of Object.entries(expected.grid)) {
    if (typeof value === 'number') assert.ok(Math.abs(grid[key] - value) <= 1e-9, item.name + ': ' + key);
    else assert.deepEqual(grid[key], value, item.name + ': ' + key);
  }
}
const exported = await decodePng(await readFile(resolve(output, 'lastTour.png')));
assert.equal(exported.width, 993); assert.equal(exported.height, 657);
const native = await decodePng(await readFile(resolve(output, 'case-0.png')));
const enlarged = await decodePng(await encodePng(native, 3));
assert.deepEqual(exported.data, enlarged.data, 'Export must use exact nearest-neighbor pixels');
const archive = await readFile(resolve(output, 'lastTour_debug.zip'));
const files = unzipStored(archive);
const info = JSON.parse(new TextDecoder().decode(files['output/debug/lastTour/info.json']));
assert.deepEqual(info.grid.output_size, [331, 219]);
assert.equal(Object.keys(files).filter(name => name.endsWith('.png')).length, 5);
const fixedInput = await decodePng(await readFile(resolve(root, 'input/lastTour.png')));
const fixedExpected = pixelize(fixedInput, {target_size: [96, 64]}, libraries);
const fixedExport = await decodePng(await readFile(resolve(output, 'lastTour_fixed.png')));
assert.equal(fixedExport.width, 192); assert.equal(fixedExport.height, 128);
const fixedEnlarged = await decodePng(await encodePng(fixedExpected.image, 2));
assert.deepEqual(fixedExport.data, fixedEnlarged.data, 'Fixed-size UI export must match the adaptive grid algorithm');
report.fixed_size = {native: [96, 64], exported: [fixedExport.width, fixedExport.height]};
report.launch_and_tests_ms = performance.now() - started;
report.runtime_detection = JSON.parse(runtime.stdout);
report.platform = process.platform; report.arch = process.arch;
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({...report, outputs: report.outputs.map(item => ({name: item.name, size: item.grid.output_size}))}, null, 2));
