// Reuse the official runtime already installed for testing. This avoids a second
// download/extraction and Windows locks on electron-builder's temporary directory.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Build the Windows x64 edition on Windows with x64 Node.js (or use the GitHub Actions job).');
}
const targets = process.argv.slice(2);
if (!targets.length || targets.some(t => !['dir', 'zip', 'portable'].includes(t)) ||
    (targets.includes('dir') && targets.length !== 1)) throw new Error('Expected dir, zip, portable, or zip portable');
const electronDist = path.dirname(require('electron'));
const run = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'),
  // The custom NSIS script is a no-install launcher, not an installer. Keep the
  // existing public "portable" command while using the supported script hook.
  '--win', ...targets.map(t => t === 'portable' ? 'nsis' : t), '--x64', '--publish', 'never', '--config.electronDist=' + electronDist],
  { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
if (run.error) throw run.error;
process.exitCode = run.status || (run.signal ? 1 : 0);
