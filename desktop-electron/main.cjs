const { app, BrowserWindow, Menu, dialog, protocol, session, shell } = require('electron');
const path = require('node:path');
const { ORIGIN, assetHandler } = require('./protocol.cjs');

// A secure standard origin enables Worker, WASM, relative URLs and crypto.subtle.
// No localhost port is opened and file:// access is never granted to the page.
protocol.registerSchemesAsPrivileged([{ scheme: 'pixelart', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);
app.setName('RealPixelArt Electron');
app.setAppUserModelId('io.github.realpixelart.electron');
const userData = app.commandLine.getSwitchValue('user-data-dir');
if (userData) app.setPath('userData', path.resolve(userData));
const smokeTest = app.commandLine.hasSwitch('smoke-test');
let mainWindow;
const REPOSITORY = 'https://github.com/Bocchi-The-Glock/Real-PixelArt';
function openRepository(address) {
  // Only this explicit repository link may leave the offline application.
  if (address === REPOSITORY) shell.openExternal(REPOSITORY).catch(error => console.error('Cannot open repository:', error));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 1000, minWidth: 800, minHeight: 600,
    title: 'RealPixelArt Electron', show: false, backgroundColor: '#f6f7f5',
    icon: path.join(__dirname, 'assets/app.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, spellcheck: false, backgroundThrottling: false },
  });
  mainWindow.on('page-title-updated', event => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openRepository(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, address) => {
    if (!address.startsWith(ORIGIN + '/')) { event.preventDefault(); openRepository(address); }
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => { if (!smokeTest) mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow.loadURL(ORIGIN + '/');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    const root = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '../build/pages');
    protocol.handle('pixelart', assetHandler(root));
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    // All processing/runtime files are bundled. Block remote requests in both UI and workers.
    session.defaultSession.webRequest.onBeforeRequest((request, done) => {
      const allowed = request.url.startsWith(ORIGIN + '/') || request.url.startsWith('blob:' + ORIGIN + '/')
        || request.url.startsWith('data:') || request.url.startsWith('devtools:');
      done({ cancel: !allowed });
    });
    session.defaultSession.on('will-download', (event, item) => {
      if (!item.getURL().startsWith('blob:' + ORIGIN + '/')) { event.preventDefault(); return; }
      const filename = path.basename(item.getFilename());
      const extension = path.extname(filename).toLowerCase();
      if (!['.png', '.zip'].includes(extension)) { event.preventDefault(); return; }
      item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), filename),
        filters: [{ name: extension === '.png' ? 'PNG image' : 'ZIP process details', extensions: [extension.slice(1)] }] });
    });
    // Keep native edit/window/quit shortcuts on macOS; the web UI provides all tools.
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
    ]) : null);
    await createWindow();
    // Only a successfully loaded packaged window authorizes the launcher to
    // retire older runtime caches after this session. User images live elsewhere.
    const runtime = process.env.PIXELART_RUNTIME_DIR;
    const build = process.env.PIXELART_RUNTIME_ID;
    if (app.isPackaged && runtime === path.dirname(process.execPath)
        && /^realpixelart-[\w.-]+-x64-[a-f0-9]{20}$/.test(build || '') && path.basename(runtime) === build) {
      await require('node:fs/promises').writeFile(path.join(runtime, '.app-started'), build).catch(console.error);
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => {
    console.error(error);
    if (!smokeTest) dialog.showErrorBox('RealPixelArt', String(error.message || error));
    app.exit(1);
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' || smokeTest) app.quit(); });
}
