'use strict';

const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, session, shell, Menu, systemPreferences, nativeTheme } = require('electron');
const { SignalingServer } = require('../server/signaling');
const { GlobalPtt } = require('./ptt');

// ---------------------------------------------------------------------------
// Profiles: `--profile=name` runs a separate identity/history (handy for
// running two clients on one machine).
// ---------------------------------------------------------------------------
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
const profile = profileArg ? profileArg.split('=')[1].replace(/[^\w-]/g, '') : process.env.VOICE_PROFILE;
if (profile) app.setPath('userData', path.join(app.getPath('appData'), `Voice-${profile}`));

// ---------------------------------------------------------------------------
// Chromium switches for real-time audio.
// ---------------------------------------------------------------------------
// Let audio start without a click (remote voices, UI sounds).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// - WebRtcAllowInputVolumeAdjustment: stops Chromium from changing the OS mic volume.
// - WebRtcHideLocalIpsWithMdns: use real LAN addresses as ICE candidates, so
//   peers on the same network connect directly even without mDNS support.
// - HardwareMediaKeyHandling: media keys belong to your music player.
app.commandLine.appendSwitch('disable-features', 'WebRtcAllowInputVolumeAdjustment,WebRtcHideLocalIpsWithMdns,HardwareMediaKeyHandling');
// Keep timers and audio running at full speed when the window is in the background.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// Automated tests: synthetic microphone, no permission prompt.
if (process.env.VOICE_FAKE_MEDIA === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

/** @type {BrowserWindow|null} */
let win = null;
/** @type {SignalingServer|null} */
let hosted = null;
const hostedLog = [];
const ptt = new GlobalPtt((down) => win?.webContents.send('ptt', down));

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (!ni.internal && ni.family === 'IPv4') out.push(ni.address);
    }
  }
  return out;
}

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
      backgroundThrottling: false,
      spellcheck: true,
    },
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Open web links in the system browser, never inside the app.
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
    {
      role: 'help',
      submenu: [{ label: 'Project on GitHub', click: () => shell.openExternal('https://github.com/hjulijulijubin/voice') }],
    },
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
  args: process.argv.filter((a) => a.startsWith('--voice-')),
}));

ipcMain.handle('server:start', async (_e, opts = {}) => {
  if (hosted) return serverStatus();
  const server = new SignalingServer({
    port: Number(opts.port) || 9987,
    name: opts.name || `${os.userInfo().username}'s server`,
    password: opts.password || '',
    stateFile: path.join(app.getPath('userData'), 'hosted-server.json'),
  });
  server.on('log', (line) => {
    hostedLog.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (hostedLog.length > 200) hostedLog.shift();
  });
  await server.start();
  hosted = server;
  return serverStatus();
});

ipcMain.handle('server:stop', async () => {
  if (hosted) await hosted.stop();
  hosted = null;
  return serverStatus();
});

ipcMain.handle('server:status', () => serverStatus());

function serverStatus() {
  if (!hosted) return { running: false };
  return {
    running: true,
    port: hosted.port,
    name: hosted.name,
    hasPassword: !!hosted.password,
    peers: hosted.peers.size,
    addresses: lanAddresses(),
    log: hostedLog.slice(-50),
  };
}

ipcMain.handle('ptt:bind', (_e, binding) => ptt.bind(binding));

ipcMain.handle('media:access', async () => {
  // macOS needs an explicit microphone permission prompt.
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
  if (hosted) hosted.stop();
});
