/** Run the native harness and preserve diagnostics for CI failures. */
import {spawn} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runNative(executable, {cwd, output, timeoutMs = 180000, env = {}, args = []}) {
  const reportPath = resolve(output, 'report.json');
  let log = '', timedOut = false, killTimer;
  const child = spawn(executable, args, {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ...env},
  });
  child.stdout.on('data', data => {log += data; process.stdout.write(data);});
  child.stderr.on('data', data => {log += data; process.stderr.write(data);});
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  }, timeoutMs);
  let code, signal, launchError;
  try {
    ({code, signal} = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept({code, signal}));
    }));
  } catch (error) {
    launchError = error;
  } finally {
    clearTimeout(timer); clearTimeout(killTimer);
    await writeFile(resolve(output, 'native.log'), log);
  }
  const progress = await readFile(resolve(output, 'progress.log'), 'utf8')
    .catch(error => {if (error.code === 'ENOENT') return ''; throw error;});
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    report = {ok: false, error: 'Native test did not produce report.json',
      code, signal, timed_out: timedOut, launch_error: launchError?.message,
      progress, native_log: log};
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  if (launchError || timedOut || code !== 0 || !report.ok) {
    throw new Error([
      launchError?.message || report.error || 'Native WebView test failed',
      'Exit code: ' + code + '; signal: ' + signal + '; timed out: ' + timedOut,
      'Progress: ' + (progress.trim() || '(no milestones recorded)'),
      log.trim(),
      'Diagnostics: ' + output,
    ].filter(Boolean).join('\n'));
  }
  return report;
}
