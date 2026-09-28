// Rasterize the existing SVG logo, then export native icon formats with Pillow.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const desktop = path.resolve(__dirname, '..');
app.setPath('userData', path.join(desktop, 'test-results/icon-profile-' + Date.now()));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false,
    transparent: true, webPreferences: { sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  const svg = fs.readFileSync(path.join(desktop, '../web/assets/favicon.svg'), 'utf8');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<style>body{margin:0;background:transparent}svg{display:block;width:1024px;height:1024px}</style>' + svg));
  const output = path.join(desktop, 'assets'); fs.mkdirSync(output, { recursive: true });
  const png = await win.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(document.querySelector('svg').outerHTML);
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
    canvas.getContext('2d').drawImage(image, 0, 0, 1024, 1024);
    return canvas.toDataURL('image/png').split(',')[1];
  })()`);
  fs.writeFileSync(path.join(output, 'app.png'), Buffer.from(png, 'base64'));
  const script = "from PIL import Image\nfrom pathlib import Path\nimport sys\np=Path(sys.argv[1])\nim=Image.open(p/'app.png')\nim.save(p/'app.ico',sizes=[(n,n) for n in [16,24,32,48,64,128,256]])\nim.save(p/'app.icns')\n";
  execFileSync(process.env.PYTHON || 'python', ['-c', script, output], { stdio: 'inherit' });
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
