// Desktop app: starts the Jarvis server and shows it in a transparent,
// frameless "hologram" window that floats over the desktop.
const { app, BrowserWindow, ipcMain, shell, globalShortcut, session, systemPreferences, safeStorage, Notification, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { createStore } = require('./server/store');
const { startServer } = require('./server/app');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win;
let srv;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 420,
    minHeight: 560,
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Jarvis',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const origin = `http://127.0.0.1:${srv.port}`;
  win.loadURL(origin + '/');

  // Links open in the real browser (or the mail/music app), never inside Jarvis.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:|spotify:|music:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  win.on('maximize', () => win.webContents.send('win-state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win-state', { maximized: false }));
  win.on('moved', relayoutSoon); // dragged to another monitor: the other screens swap roles
  win.on('closed', () => { win = null; closeSatellites(); });
  // Closing or minimizing tucks Jarvis into the menu bar / system tray (he keeps listening).
  win.on('close', e => {
    if (!quitting && trayPrefs().keep) { e.preventDefault(); hideToTray(); }
  });
}

// ---------------------------------------------------------------- menu bar (Mac) / system tray (Windows)
let tray = null;
let quitting = false;
const trayFile = () => path.join(app.getPath('userData'), 'tray.json');
function trayPrefs() {
  try { return { keep: true, ...JSON.parse(fs.readFileSync(trayFile(), 'utf8')) }; } catch { return { keep: true }; }
}

function showWindow() {
  if (!win) createWindow();
  if (process.platform === 'darwin') app.dock?.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  for (const w of satellites) if (!w.isDestroyed()) w.showInactive();
}

function hideToTray() {
  if (!win) return;
  win.hide();
  for (const w of satellites) if (!w.isDestroyed()) w.hide();
  if (process.platform === 'darwin') app.dock?.hide();
}

function createTray() {
  if (tray) return;
  const isMac = process.platform === 'darwin';
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Jarvis');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Jarvis', click: showWindow },
    { label: 'Talk now', click: () => { showWindow(); win.webContents.send('hotkey-listen'); } },
    { type: 'separator' },
    { label: 'Check for updates', click: () => { showWindow(); checkForUpdates(); } },
    { type: 'separator' },
    { label: 'Quit Jarvis', click: () => { quitting = true; app.quit(); } },
  ]));
  if (!isMac) tray.on('click', showWindow); // Windows: click the tray icon to bring Jarvis back
}

app.on('before-quit', () => { quitting = true; });

// ---------------------------------------------------------------- free updates
// New versions are published as GitHub Releases. Windows downloads them in the
// background and installs on restart; Macs (unsigned) get a download link.
const UPDATE_REPO = require('./package.json').updateRepo || '';
const releasesPage = () => `https://github.com/${UPDATE_REPO}/releases/latest`;

// Latest update status, shown in Settings → Updates.
// state: idle | checking | none | available | downloading | ready | error | unavailable
let updateState = { state: 'idle' };
const updatesEnabled = () => app.isPackaged && UPDATE_REPO && !UPDATE_REPO.startsWith('YOUR_');

function setUpdate(data) {
  updateState = { ...updateState, ...data, at: Date.now() };
  if (win && !win.isDestroyed()) win.webContents.send('update', updateState);
}

function checkForUpdates() {
  if (!updatesEnabled()) return setUpdate({ state: 'unavailable' });
  if (['downloading', 'ready'].includes(updateState.state)) return; // already on its way
  setUpdate({ state: 'checking' });
  autoUpdater.checkForUpdates().catch(e => setUpdate({ state: 'error', error: e.message }));
}

function setupUpdates() {
  if (!updatesEnabled()) return;
  autoUpdater.autoDownload = process.platform !== 'darwin';
  autoUpdater.on('update-available', info => setUpdate({ state: process.platform === 'darwin' ? 'available' : 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'none' }));
  autoUpdater.on('download-progress', p => setUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => setUpdate({ state: 'ready', version: info.version }));
  autoUpdater.on('error', e => setUpdate({ state: 'error', error: String(e?.message || e).slice(0, 200) }));
  setTimeout(checkForUpdates, 15_000);
  setInterval(checkForUpdates, 4 * 3600 * 1000);
}

ipcMain.handle('update:state', () => ({ ...updateState, current: app.getVersion(), enabled: !!updatesEnabled(), platform: process.platform }));
ipcMain.on('update:check', () => checkForUpdates());

// ---------------------------------------------------------------- start with the computer
// On by default for installed copies (first run only); the person can switch it off.
function setupAutoStart() {
  if (!app.isPackaged) return;
  const flag = path.join(app.getPath('userData'), 'autostart-set');
  if (!fs.existsSync(flag)) {
    app.setLoginItemSettings({ openAtLogin: true });
    fs.writeFileSync(flag, '1');
  }
}
ipcMain.handle('autostart:get', () => ({ available: app.isPackaged, on: app.isPackaged && app.getLoginItemSettings().openAtLogin }));
ipcMain.handle('autostart:set', (_e, on) => {
  if (!app.isPackaged) return { available: false, on: false };
  app.setLoginItemSettings({ openAtLogin: !!on });
  return { available: true, on: app.getLoginItemSettings().openAtLogin };
});

ipcMain.on('update:install', () => { quitting = true; autoUpdater.quitAndInstall(); });
ipcMain.on('update:page', () => shell.openExternal(releasesPage()));
ipcMain.handle('app:version', () => app.getVersion());

// ---------------------------------------------------------------- extra monitors
// Each extra monitor gets its own hologram display (not a mirror): views
// alternate between "systems" and "intel". They are click-through by default
// so they float over whatever is on those screens.
let satellites = [];
let relayoutTimer = null;
const displayFile = () => path.join(app.getPath('userData'), 'displays.json');

function displayPrefs() {
  try { return { mode: 'single', clickThrough: true, ...JSON.parse(fs.readFileSync(displayFile(), 'utf8')) }; }
  catch { return { mode: 'single', clickThrough: true }; }
}

function closeSatellites() {
  for (const w of satellites) if (!w.isDestroyed()) w.destroy();
  satellites = [];
}

function layoutSatellites() {
  closeSatellites();
  const prefs = displayPrefs();
  if (prefs.mode !== 'all' || !win || win.isDestroyed()) return;
  const home = screen.getDisplayMatching(win.getBounds());
  const others = screen.getAllDisplays().filter(d => d.id !== home.id).sort((a, b) => a.bounds.x - b.bounds.x);
  others.forEach((d, i) => {
    const w = new BrowserWindow({
      ...d.workArea,
      transparent: true, frame: false, hasShadow: false, backgroundColor: '#00000000',
      skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      focusable: !prefs.clickThrough, title: 'Jarvis display',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    w.setBounds(d.workArea);
    if (prefs.clickThrough) w.setIgnoreMouseEvents(true);
    w.loadURL(`http://127.0.0.1:${srv.port}/satellite.html?view=${i % 2 === 0 ? 'systems' : 'intel'}&n=${i + 2}`);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    satellites.push(w);
  });
}

function relayoutSoon() {
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(() => {
    if (displayPrefs().mode !== 'all' || !win) return;
    // Only rebuild when the main window changed monitor or the monitor setup changed.
    const home = screen.getDisplayMatching(win.getBounds()).id;
    const key = home + ':' + screen.getAllDisplays().map(d => d.id + '@' + JSON.stringify(d.workArea)).join('|');
    if (key !== relayoutSoon.key) { relayoutSoon.key = key; layoutSatellites(); }
  }, 600);
}

app.whenReady().then(async () => {
  const box = safeStorage.isEncryptionAvailable()
    ? { encrypt: v => safeStorage.encryptString(v).toString('base64'), decrypt: v => safeStorage.decryptString(Buffer.from(v, 'base64')) }
    : null;
  const store = createStore(app.getPath('userData'), box);
  srv = await startServer({
    store,
    notify: (title, body) => { if (Notification.isSupported()) new Notification({ title, body }).show(); },
  });

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'clipboard-sanitized-write', 'notifications'].includes(permission) && wc.getURL().startsWith(`http://127.0.0.1:${srv.port}`));
  });
  if (process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').catch(() => {});

  createWindow();
  win.webContents.once('did-finish-load', relayoutSoon);
  setupUpdates();
  setupAutoStart();
  createTray();
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, relayoutSoon);

  globalShortcut.register('CommandOrControl+Shift+J', () => {
    showWindow();
    win.webContents.send('hotkey-listen');
  });

  app.on('activate', () => showWindow()); // Mac: clicking the Dock icon brings Jarvis back
}).catch(e => {
  console.error(e);
  app.quit();
});

ipcMain.on('win:minimize', () => { if (trayPrefs().keep) hideToTray(); else win?.minimize(); });
ipcMain.handle('tray:get', () => trayPrefs());
// Eyes: screenshot of the monitor the mouse is on (Jarvis hides for a moment so he isn't in it).
ipcMain.handle('capture-screen', async () => {
  const { desktopCapturer } = require('electron');
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wasVisible = win?.isVisible();
  if (wasVisible) win.setOpacity(0);
  for (const w of satellites) if (!w.isDestroyed()) w.setOpacity(0);
  await new Promise(r => setTimeout(r, 250));
  try {
    const scale = Math.min(1, 1600 / display.size.width);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
    const src = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
    return src ? 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(80).toString('base64') : null;
  } finally {
    if (wasVisible) win.setOpacity(1);
    for (const w of satellites) if (!w.isDestroyed()) w.setOpacity(1);
  }
});
ipcMain.handle('pick-folder', async () => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a folder for the Second Brain' });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('tray:set', (_e, keep) => { fs.writeFileSync(trayFile(), JSON.stringify({ keep: !!keep })); return trayPrefs(); });
ipcMain.on('win:maximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win:close', () => win?.close());
// Background style: 'clear' (see-through), 'frosted' (blurred desktop behind), 'solid'.
// Frosted uses the system glass effect: Acrylic on Windows 11, vibrancy on Mac.
ipcMain.handle('win:background', (_e, style) => {
  if (!win) return { blur: false };
  let blur = false;
  try {
    if (process.platform === 'darwin') {
      win.setVibrancy(style === 'frosted' ? 'under-window' : null);
      blur = style === 'frosted';
    } else if (process.platform === 'win32' && typeof win.setBackgroundMaterial === 'function') {
      win.setBackgroundMaterial(style === 'frosted' ? 'acrylic' : 'none');
      blur = style === 'frosted' && Number(require('os').release().split('.')[2]) >= 22621; // Windows 11 22H2+
    }
  } catch {}
  return { blur };
});
ipcMain.handle('win:on-top',(_e, on) => { win?.setAlwaysOnTop(!!on, 'floating'); return win?.isAlwaysOnTop(); });
ipcMain.handle('displays:get', () => ({ count: screen.getAllDisplays().length, ...displayPrefs() }));
ipcMain.handle('displays:set', (_e, prefs) => {
  const next = { ...displayPrefs(), mode: prefs.mode === 'all' ? 'all' : 'single', clickThrough: prefs.clickThrough !== false };
  fs.writeFileSync(displayFile(), JSON.stringify(next));
  relayoutSoon.key = null;
  layoutSatellites();
  return { count: screen.getAllDisplays().length, ...next };
});
// The main window tells the other screens when Jarvis listens/thinks/speaks.
ipcMain.on('holo-mode', (_e, mode) => {
  for (const w of satellites) if (!w.isDestroyed()) w.webContents.send('holo-mode', mode);
});
ipcMain.handle('open-external',(_e, url) => { if (/^(https?:|mailto:|spotify:|music:)/i.test(url)) shell.openExternal(url); });

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
