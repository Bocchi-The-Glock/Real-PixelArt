import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runNative} from '../scripts/native-test.mjs';

async function fixture(t) {
  const output = await mkdtemp(join(tmpdir(), 'realpixelart-smoke-'));
  t.after(() => rm(output, {recursive: true, force: true}));
  return output;
}
test('successful native report is returned and console output is saved', async t => {
  const output = await fixture(t);
  const report = await runNative(process.execPath, {cwd: output, output,
    args: ['-e', "require('fs').writeFileSync('report.json',JSON.stringify({ok:true})); console.log('done');"]});
  assert.equal(report.ok, true);
  assert.match(await readFile(join(output, 'native.log'), 'utf8'), /done/);
});
test('an early exit preserves the real error instead of reporting ENOENT', async t => {
  const output = await fixture(t);
  await writeFile(join(output, 'progress.log'), 'native startup\n');
  await assert.rejects(runNative(process.execPath, {cwd: output, output,
    args: ['-e', "console.error('window creation failed'); process.exit(7);"]}),
    error => /Exit code: 7/.test(error.message) && /window creation failed/.test(error.message));
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  assert.equal(report.ok, false);
  assert.equal(report.code, 7);
  assert.match(report.progress, /native startup/);
});
test('a stalled WebView produces a failure report with the last milestone', async t => {
  const output = await fixture(t);
  await writeFile(join(output, 'progress.log'), 'DOM loaded; waiting for engine\n');
  await assert.rejects(runNative(process.execPath, {cwd: output, output, timeoutMs: 250,
    args: ['-e', 'setInterval(() => {}, 1000);']}), /timed out: true/);
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  assert.equal(report.timed_out, true);
  assert.match(report.progress, /waiting for engine/);
});
