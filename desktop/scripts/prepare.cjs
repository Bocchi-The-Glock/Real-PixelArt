// The browser and desktop ship exactly the same native JavaScript assets.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
for (const script of ['web/build.mjs']) {
  const run = spawnSync(process.execPath, [script, '--out', 'build/pages'], { cwd: root, stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status || 1);
}
