'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, session, shell, Menu, systemPreferences, nativeTheme, protocol, net, dialog } = require('electron');
const { Rendezvous } = require('./rendezvous');
const { FileStore, safeName } = require('./filestore');
const { GlobalPtt } = require('./ptt');

// ---------------------------------------------------------------------------
// Profiles: `--profile=name` runs a separate identity/history (handy for
// running several clients on one machine).
// ---------------------------------------------------------------------------
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
const profile = profileArg ? profileArg.split('=')[1].replace(/[^\w-]/g, '') : process.env.VOICE_PROFILE;
if (profile) app.setPath('userData', path.join(app.getPath('appData'), `Voice-${profile}`));

// Small main-process config (things needed before the window exists).
const configPath = path.join(app.getPath('userData'), 'config.json');
let config = { hardwareAcceleration: true };
try {
  config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
} catch {
  /* first start */
}
if (!config.hardwareAcceleration) app.disableHardwareAcceleration();

// ---------------------------------------------------------------------------
// Chromium switches for real-time audio.
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// - WebRtcAllowInputVolumeAdjustment: never change the OS mic volume.
// - WebRtcHideLocalIpsWithMdns: real LAN candidates, so peers on one network
//   connect directly even where mDNS doesn't resolve.
// - HardwareMediaKeyHandling: media keys belong to the music player.
// - SpareRendererForSitePerProcess: no idle spare renderer process (RAM).
app.commandLine.appendSwitch(
  'disable-features',
  'WebRtcAllowInputVolumeAdjustment,WebRtcHideLocalIpsWithMdns,HardwareMediaKeyHandling,SpareRendererForSitePerProcess',
);

if (process.env.VOICE_FAKE_MEDIA === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

// voicefile://<room>/<file> serves shared files straight from disk.
protocol.registerSchemesAsPrivileged([{ scheme: 'voicefile', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

// `voice:` links open invites. One instance per profile.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
if (!process.defaultApp) app.setAsDefaultProtocolClient('voice');

/** @type {BrowserWindow|null} */
let win = null;
let pendingInvite = findInvite(process.argv);
const rendezvous = new Rendezvous();
const files = new FileStore(path.join(app.getPath('userData'), 'rooms'));
const ptt = new GlobalPtt((down) => win?.webContents.send('ptt', down));

function findInvite(argv) {
  return argv.find((a) => /^voice:/i.test(a)) || null;
}

function deliverInvite(code) {
  if (!code) return;
  if (win && !win.webContents.isLoading()) {
    win.webContents.send('invite', code);
    if (win.isMinimized()) win.restore();
    win.focus();
  } else {
    pendingInvite = code;
  }
}

app.on('second-instance', (_e, argv) => {
  deliverInvite(findInvite(argv));
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  deliverInvite(url);
});

rendezvous.on('message', (m) => win?.webContents.send('rv:message', m));
rendezvous.on('status', () => win?.webContents.send('rv:status', rendezvous.status()));

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#1e1f22',
    title: 'Voice',
    icon: path.join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Push-to-talk release timers must stay accurate in the background.
      backgroundThrottling: false,
      // Spellcheck would download dictionaries from Google: off for privacy and RAM.
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.webContents.on('did-finish-load', () => {
    if (pendingInvite) {
      win.webContents.send('invite', pendingInvite);
      pendingInvite = null;
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.on('focus', () => win?.flashFrame(false));
  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Project on GitHub', click: () => shell.openExternal('https://github.com/hjulijulijubin/voice') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  profile: profile || null,
  globalPtt: ptt.available,
  hardwareAcceleration: config.hardwareAcceleration,
  args: process.argv.filter((a) => a.startsWith('--voice-')),
}));

ipcMain.handle('app:set-hardware-acceleration', async (_e, enabled) => {
  config.hardwareAcceleration = !!enabled;
  await fsp.writeFile(configPath, JSON.stringify(config));
  app.relaunch();
  app.exit(0);
});

// Rendezvous
ipcMain.handle('rv:configure', (_e, opts) => rendezvous.configure(opts || {}));
ipcMain.handle('rv:join', (_e, topic) => rendezvous.join(String(topic)));
ipcMain.handle('rv:leave', (_e, topic) => rendezvous.leave(String(topic)));
ipcMain.handle('rv:publish', (_e, topic, payload) => rendezvous.publish(String(topic), payload));
ipcMain.handle('rv:status', () => rendezvous.status());

// File store
ipcMain.handle('fs:begin', (_e, room, fileId) => files.begin(room, fileId));
ipcMain.handle('fs:write', (_e, token, offset, data) => files.write(token, offset, data));
ipcMain.handle('fs:finish', (_e, token, sha) => files.finish(token, sha));
ipcMain.handle('fs:abort', (_e, token) => files.abort(token));
ipcMain.handle('fs:import', (_e, room, fileId, src) => files.importPath(room, fileId, String(src)));
ipcMain.handle('fs:read', (_e, room, fileId, offset, length) => files.read(room, fileId, offset, Math.min(length, 1 << 20)));
ipcMain.handle('fs:size', (_e, room, fileId) => files.size(room, fileId));
ipcMain.handle('fs:remove', (_e, room, fileId) => files.remove(room, fileId));
ipcMain.handle('fs:list', (_e, room) => files.list(room));
ipcMain.handle('fs:remove-room', (_e, room) => files.removeRoom(room));
ipcMain.handle('fs:save-as', async (_e, room, fileId, name) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), safeName(name)) });
  if (canceled || !filePath) return false;
  await fsp.copyFile(files.path(room, fileId), filePath);
  return true;
});
ipcMain.handle('fs:open', async (_e, room, fileId, name) => {
  // Opening with the system's default app needs the real file name/extension.
  const dir = path.join(os.tmpdir(), 'voice-open', fileId);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, safeName(name));
  await fsp.copyFile(files.path(room, fileId), target);
  return !(await shell.openPath(target));
});

ipcMain.handle('ptt:bind', (_e, binding) => ptt.bind(binding));

ipcMain.handle('media:access', async () => {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
    return systemPreferences.askForMediaAccess('microphone');
  }
  return true;
});

ipcMain.on('app:attention', () => {
  if (win && !win.isFocused()) {
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    else win.flashFrame(true);
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'speaker-selection', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  protocol.handle('voicefile', async (req) => {
    try {
      const url = new URL(req.url);
      const p = files.path(url.hostname, url.pathname.slice(1));
      const res = await net.fetch(pathToFileURL(p).toString(), { headers: req.headers });
      const headers = new Headers(res.headers);
      const type = url.searchParams.get('type');
      if (type && /^[\w.+-]+\/[\w.+-]+$/.test(type)) headers.set('content-type', type);
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  ptt.stop();
  rendezvous.stop();
});
