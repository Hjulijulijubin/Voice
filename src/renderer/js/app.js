import { h, uid, prefs, formatTime, formatBytes, debounce } from './util.js';
import { icon } from './icons.js';
import { toast, avatar, modal, promptModal, confirmModal, popover, closePopover } from './ui.js';
import { SignalingClient } from './signaling-client.js';
import { Mesh, DEFAULT_ICE_SERVERS } from './mesh.js';
import { AudioEngine, Sfx } from './audio.js';
import { FileManager } from './files.js';
import { store } from './store.js';
import { renderText, mentionsMe } from './richtext.js';
import { loadSettings, saveSettings, openSettings, parseIceServers, describeBinding } from './settings.js';

const $ = (id) => document.getElementById(id);
const AUTO_DOWNLOAD_LIMIT = 25 * 1024 * 1024; // images/audio/video below this are fetched automatically
const MAX_MESSAGE = 4000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const settings = loadSettings();
const userId = prefs.get('userId', null) || uid();
prefs.set('userId', userId);

const state = {
  name: prefs.get('name', ''),
  connected: false,
  address: null,
  password: '',
  serverKey: null,
  serverName: '',
  selfId: null,
  channels: [],
  /** peerId -> {id, userId, name, voice, muted, deafened} */
  peers: new Map(),
  textChannel: 'general',
  voice: null,
  muted: prefs.get('muted', false),
  deafened: prefs.get('deafened', false),
  unread: new Map(),
  hosting: false,
  typing: new Map(), // userId -> {name, channel, until}
  membersVisible: prefs.get('membersVisible', true),
  reconnecting: false,
  appInfo: { globalPtt: false, platform: 'linux', args: [] },
};

const signaling = new SignalingClient();
const audio = new AudioEngine(settings);
const sfx = new Sfx();
let mesh = null;
let files = null;
let lastTyping = 0;

// ---------------------------------------------------------------------------
// Context handed to the settings dialog
// ---------------------------------------------------------------------------
const appCtx = {
  settings,
  audio,
  get name() {
    return state.name;
  },
  get globalPtt() {
    return state.appInfo.globalPtt;
  },
  get platform() {
    return state.appInfo.platform;
  },
  requestMediaAccess: () => window.voice.requestMediaAccess(),
  async ensureMic() {
    if (audio.running) return;
    await window.voice.requestMediaAccess();
    await audio.start();
  },
  releaseMicIfIdle() {
    if (!state.voice && audio.running && !audio.loopbackActive) audio.stop();
  },
  async restartMic() {
    try {
      await audio.restart();
    } catch (err) {
      toast(`Microphone error: ${err.message}`, 'error');
    }
  },
  applyOutput() {
    mesh?.setOutputDevice(settings.outputDeviceId);
    sfx.setSink(settings.outputDeviceId);
  },
  applyQuality() {
    mesh?.applyQuality();
  },
  applyJitterTarget() {
    mesh?.applyJitterTarget();
  },
  bindPtt,
  renderSelf,
  applyMisc() {
    sfx.enabled = settings.sounds;
  },
  setName(name) {
    state.name = name.slice(0, 32);
    prefs.set('name', state.name);
    sendState();
    renderSelf();
    toast('Name updated');
  },
};

// ---------------------------------------------------------------------------
// Connect screen
// ---------------------------------------------------------------------------
function recentServers() {
  return prefs.get('recent', []);
}

function rememberServer(address) {
  const list = recentServers().filter((a) => a !== address);
  list.unshift(address);
  prefs.set('recent', list.slice(0, 6));
}

function renderConnect() {
  $('cv-name').value = state.name;
  const last = recentServers()[0];
  if (last && !$('cv-address').value) $('cv-address').value = last;
  $('hv-name').value = prefs.get('hostName', '') || (state.name ? `${state.name}'s server` : '');
  $('hv-port').value = prefs.get('hostPort', 9987);
  const recent = $('recent-servers');
  recent.replaceChildren(
    ...recentServers().map((a) =>
      h(
        'button',
        {
          type: 'button',
          title: 'Use this address',
          onclick: () => {
            $('cv-address').value = a;
          },
        },
        a,
      ),
    ),
  );
}

function readName() {
  const name = $('cv-name').value.trim();
  if (!name) {
    $('connect-error').textContent = 'Please choose a display name first.';
    $('cv-name').focus();
    return null;
  }
  state.name = name.slice(0, 32);
  prefs.set('name', state.name);
  return state.name;
}

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!readName()) return;
  const address = $('cv-address').value.trim();
  if (!address) return;
  await connect(address, $('cv-password').value);
});

$('host-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!readName()) return;
  const port = Number($('hv-port').value) || 9987;
  const name = $('hv-name').value.trim() || `${state.name}'s server`;
  const password = $('hv-password').value;
  prefs.set('hostName', name);
  prefs.set('hostPort', port);
  $('connect-error').textContent = '';
  try {
    const status = await window.voice.startServer({ port, name, password });
    state.hosting = true;
    await connect(`127.0.0.1:${status.port}`, password, { remember: false });
  } catch (err) {
    $('connect-error').textContent = `Could not start server: ${err.message}`;
  }
});

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------
async function connect(address, password, { remember = true, silent = false } = {}) {
  $('connect-error').textContent = '';
  const submitButtons = document.querySelectorAll('#connect-view button[type=submit]');
  submitButtons.forEach((b) => (b.disabled = true));
  try {
    const welcome = await signaling.connect(address, { name: state.name, userId, password });
    state.address = address;
    state.password = password;
    state.serverKey = signaling.url;
    state.serverName = welcome.serverName;
    state.selfId = welcome.id;
    state.channels = welcome.channels;
    state.peers = new Map(welcome.peers.map((p) => [p.id, p]));
    state.connected = true;
    if (remember) rememberServer(address);
    if (!state.channels.some((c) => c.id === state.textChannel && c.type === 'text')) {
      state.textChannel = state.channels.find((c) => c.type === 'text')?.id;
    }

    setupMesh(welcome.iceServers || []);
    for (const peer of welcome.peers) mesh.connectTo(peer);

    showMain();
    if (!silent) sfx.play('connect');
    // Rejoin the voice channel after a reconnect.
    if (state.voice && state.channels.some((c) => c.id === state.voice)) {
      mesh.setLocalTrack(audio.track);
      mesh.setVoiceChannel(state.voice);
    } else {
      state.voice = null;
    }
    sendState();
    renderAll();
    await openTextChannel(state.textChannel);
  } catch (err) {
    if (!silent) $('connect-error').textContent = err.message;
    throw err;
  } finally {
    submitButtons.forEach((b) => (b.disabled = false));
  }
}

function setupMesh(serverIce) {
  mesh?.destroy();
  const iceServers = [...DEFAULT_ICE_SERVERS, ...parseIceServers(settings.iceServers), ...serverIce];
  mesh = new Mesh({
    signaling,
    selfId: state.selfId,
    iceServers,
    getQuality: () => settings.quality,
    getJitterTargetMs: () => settings.jitterTargetMs,
  });
  mesh.setOutputDevice(settings.outputDeviceId);
  mesh.setDeafened(state.deafened);
  for (const [uidKey, vol] of Object.entries(prefs.get('volumes', {}))) mesh.volumes.set(uidKey, vol);
  for (const u of prefs.get('localMutes', [])) mesh.localMutes.add(u);
  files = new FileManager(mesh);

  mesh.on('peer-open', async (peer) => {
    // Ask for any chat history we don't have yet.
    const since = await store.latestTimestamp(state.serverKey).catch(() => 0);
    peer.sendJson({ t: 'sync-req', since });
    renderMembers();
  });
  mesh.on('peer-state', () => {
    renderMembers();
    renderChannels();
  });
  mesh.on('speaking', () => renderSpeaking());
  mesh.on('data', (peer, msg) => onPeerData(peer, msg));
  files.on('progress', (fileId, frac) => updateFileProgress(fileId, frac));
  files.on('uploads', (n) => {
    const el = $('upload-indicator');
    el.classList.toggle('hidden', n === 0);
    el.textContent = n ? `Uploading to ${n} peer${n > 1 ? 's' : ''}…` : '';
  });
}

signaling.on('peer-joined', ({ peer }) => {
  state.peers.set(peer.id, peer);
  mesh?.expect(peer);
  mesh?.updateInfo(peer);
  renderMembers();
  renderChannels();
});

signaling.on('peer-left', ({ id }) => {
  const peer = state.peers.get(id);
  state.peers.delete(id);
  mesh?.remove(id);
  files?.peerGone(id);
  if (peer && state.voice && peer.voice === state.voice) sfx.play('leave');
  renderMembers();
  renderChannels();
  renderTyping();
});

signaling.on('peer-state', ({ peer }) => {
  if (peer.id === state.selfId) return;
  const before = state.peers.get(peer.id);
  state.peers.set(peer.id, peer);
  mesh?.updateInfo(peer);
  if (state.voice) {
    if (peer.voice === state.voice && before?.voice !== state.voice) sfx.play('join');
    if (before?.voice === state.voice && peer.voice !== state.voice) sfx.play('leave');
  }
  renderMembers();
  renderChannels();
});

signaling.on('signal', ({ from, data }) => mesh?.onSignal(from, data));

signaling.on('channels', ({ channels }) => {
  state.channels = channels;
  if (!channels.some((c) => c.id === state.textChannel)) openTextChannel(channels.find((c) => c.type === 'text')?.id);
  if (state.voice && !channels.some((c) => c.id === state.voice)) leaveVoice();
  renderChannels();
});

signaling.on('disconnected', (ev) => {
  if (!state.connected) return;
  if (ev.code === 4003) {
    // Same identity connected from somewhere else.
    toast('You connected from another window — this session was closed.', 'error', 8000);
    leaveServer();
    return;
  }
  mesh?.destroy();
  mesh = null;
  state.peers.clear();
  renderAll();
  $('reconnect-banner').classList.remove('hidden');
  scheduleReconnect(1000);
});

function scheduleReconnect(delay) {
  if (state.reconnecting) return;
  state.reconnecting = true;
  setTimeout(async () => {
    state.reconnecting = false;
    if (!state.connected) return;
    try {
      await connect(state.address, state.password, { remember: false, silent: true });
      $('reconnect-banner').classList.add('hidden');
      toast('Reconnected');
    } catch {
      scheduleReconnect(Math.min(delay * 2, 15000));
    }
  }, delay);
}

async function leaveServer() {
  state.connected = false;
  leaveVoice({ silent: true });
  signaling.close();
  mesh?.destroy();
  mesh = null;
  files = null;
  state.peers.clear();
  if (state.hosting) {
    await window.voice.stopServer();
    state.hosting = false;
  }
  $('reconnect-banner').classList.add('hidden');
  $('main-view').classList.add('hidden');
  $('connect-view').classList.remove('hidden');
  renderConnect();
}

function sendState() {
  signaling.send({ type: 'state', voice: state.voice, muted: state.muted, deafened: state.deafened, name: state.name });
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------
async function joinVoice(channelId) {
  if (state.voice === channelId) return;
  try {
    await appCtx.ensureMic();
  } catch (err) {
    toast(`Cannot access microphone: ${err.message}`, 'error', 7000);
    return;
  }
  state.voice = channelId;
  audio.setMuted(state.muted);
  audio.setDeafened(state.deafened);
  mesh?.setLocalTrack(audio.track);
  mesh?.setVoiceChannel(channelId);
  sendState();
  sfx.play('join');
  renderVoiceState();
}

function leaveVoice({ silent = false } = {}) {
  if (!state.voice) return;
  state.voice = null;
  mesh?.setVoiceChannel(null);
  mesh?.setLocalTrack(null);
  if (!audio.loopbackActive) audio.stop();
  sendState();
  if (!silent) sfx.play('leave');
  renderVoiceState();
}

function setMuted(muted) {
  state.muted = muted;
  if (!muted && state.deafened) setDeafened(false, true);
  prefs.set('muted', muted);
  audio.setMuted(muted);
  sfx.play(muted ? 'mute' : 'unmute');
  sendState();
  renderVoiceState();
}

function setDeafened(deafened, quiet = false) {
  state.deafened = deafened;
  prefs.set('deafened', deafened);
  audio.setDeafened(deafened);
  mesh?.setDeafened(deafened);
  if (!quiet) sfx.play(deafened ? 'mute' : 'unmute');
  sendState();
  renderVoiceState();
}

async function bindPtt() {
  const global = settings.inputMode === 'ptt' ? await window.voice.bindPtt(settings.pttBinding) : await window.voice.bindPtt(null);
  state.globalPttActive = global;
  renderSelf();
}

function matchesBinding(e) {
  const b = settings.pttBinding;
  if (!b || settings.inputMode !== 'ptt') return false;
  if (b.type === 'key') return e.code === b.code;
  return e.button === b.button;
}

window.addEventListener('keydown', (e) => {
  // Shortcuts
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyM') {
    e.preventDefault();
    if (state.connected) setMuted(!state.muted);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    if (state.connected) setDeafened(!state.deafened);
    return;
  }
  if (e.repeat || !matchesBinding(e)) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  // Plain letter keys still type normally in text fields.
  if (typing && /^(Key|Digit|Space)/.test(e.code) && !state.globalPttActive) return;
  audio.setPtt(true);
});
window.addEventListener('keyup', (e) => {
  if (matchesBinding(e)) audio.setPtt(false);
});
window.addEventListener('mousedown', (e) => e.button > 0 && matchesBinding(e) && audio.setPtt(true));
window.addEventListener('mouseup', (e) => e.button > 0 && matchesBinding(e) && audio.setPtt(false));
window.addEventListener('blur', () => {
  // Without a global hook we would never see the key-up while unfocused.
  if (!state.globalPttActive) audio.setPtt(false);
});
window.voice.onPtt((down) => audio.setPtt(down));

audio.on('transmitting', () => renderSpeaking());
audio.on('device-lost', () => {
  toast('Microphone disconnected — switching to the default device.', 'error');
  settings.inputDeviceId = '';
  saveSettings(settings);
  appCtx.restartMic();
});
audio.on('track', (track) => mesh?.setLocalTrack(state.voice ? track : null));

// Voice panel stats (ping, bitrate)
setInterval(async () => {
  if (!state.voice || !mesh) return;
  const peers = [...mesh.peers.values()].filter((p) => p.together);
  if (!peers.length) {
    $('vp-stats').textContent = 'Alone in channel';
    $('vp-status').classList.remove('warn');
    $('vp-status').textContent = 'Voice Connected';
    return;
  }
  const stats = await Promise.all(peers.map((p) => p.getStats().catch(() => null)));
  const valid = stats.filter(Boolean);
  const rtts = valid.map((s) => s.rttMs).filter((v) => v != null);
  const out = valid.map((s) => s.outKbps).filter((v) => v != null);
  const loss = valid.map((s) => s.lossPct).filter((v) => v != null);
  const avgRtt = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
  const maxLoss = loss.length ? Math.max(...loss) : 0;
  const allConnected = peers.every((p) => p.state === 'connected');
  $('vp-status').textContent = allConnected ? 'Voice Connected' : 'Connecting…';
  $('vp-status').classList.toggle('warn', !allConnected || maxLoss > 2);
  const parts = [];
  if (avgRtt != null) parts.push(`${Math.round(avgRtt)} ms`);
  if (out.length) parts.push(`↑ ${Math.round(Math.max(...out))} kbps`);
  if (maxLoss > 0.5) parts.push(`${maxLoss.toFixed(1)}% loss`);
  $('vp-stats').textContent = parts.join(' · ');
}, 1000);

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function validMessage(m) {
  return (
    m &&
    typeof m.id === 'string' &&
    m.id.length <= 64 &&
    typeof m.channel === 'string' &&
    typeof m.ts === 'number' &&
    typeof m.text === 'string' &&
    m.text.length <= MAX_MESSAGE &&
    m.author &&
    typeof m.author.userId === 'string' &&
    typeof m.author.name === 'string' &&
    (!m.file || (typeof m.file.id === 'string' && typeof m.file.name === 'string' && typeof m.file.size === 'number'))
  );
}

function sanitize(m) {
  const out = { id: m.id, channel: m.channel, ts: m.ts, text: m.text, author: { userId: m.author.userId, name: String(m.author.name).slice(0, 32) } };
  if (m.file) out.file = { id: m.file.id, name: String(m.file.name).slice(0, 255), size: m.file.size, type: String(m.file.type || '').slice(0, 100) };
  return out;
}

async function onPeerData(peer, msg) {
  if (!msg || typeof msg.t !== 'string') return;
  switch (msg.t) {
    case 'msg': {
      if (!validMessage(msg.msg)) return;
      const m = sanitize(msg.msg);
      // Live messages must come from their author.
      if (m.author.userId !== peer.info.userId) return;
      await receiveMessage(m, true);
      break;
    }
    case 'sync-req': {
      const since = typeof msg.since === 'number' ? msg.since : 0;
      const msgs = await store.getMessagesSince(state.serverKey, since).catch(() => []);
      for (let i = 0; i < msgs.length; i += 50) {
        peer.sendJson({ t: 'sync', msgs: msgs.slice(i, i + 50).map(sanitize) });
      }
      break;
    }
    case 'sync': {
      if (!Array.isArray(msg.msgs)) return;
      let touchedCurrent = false;
      for (const raw of msg.msgs) {
        if (!validMessage(raw)) continue;
        const m = sanitize(raw);
        const isNew = await store.addMessage(state.serverKey, m).catch(() => false);
        if (isNew && m.channel === state.textChannel) touchedCurrent = true;
      }
      if (touchedCurrent) await openTextChannel(state.textChannel, true);
      break;
    }
    case 'typing': {
      if (typeof msg.channel !== 'string') return;
      state.typing.set(peer.info.userId, { name: peer.info.name, channel: msg.channel, until: Date.now() + 4000 });
      renderTyping();
      break;
    }
    default:
      if (msg.t.startsWith('file-')) files?.onControl(peer, msg);
  }
}

async function receiveMessage(m, live) {
  const isNew = await store.addMessage(state.serverKey, m).catch(() => false);
  if (!isNew) return;
  state.typing.delete(m.author.userId);
  renderTyping();
  const mine = m.author.userId === userId;
  if (m.channel === state.textChannel) {
    appendMessage(m);
  } else if (!mine) {
    state.unread.set(m.channel, (state.unread.get(m.channel) || 0) + 1);
    renderChannels();
  }
  if (live && !mine) {
    const mentioned = mentionsMe(m.text, state.name);
    if (mentioned || !document.hasFocus()) {
      if (settings.sounds) sfx.play('message');
      window.voice.attention();
    }
    if (mentioned && settings.notifications && !document.hasFocus()) {
      const ch = state.channels.find((c) => c.id === m.channel);
      new Notification(`${m.author.name} in #${ch?.name || m.channel}`, { body: m.text.slice(0, 200), silent: true });
    }
  }
}

async function sendMessage(text, file = null) {
  if (!state.connected || !state.textChannel) return;
  const m = { id: uid(), channel: state.textChannel, ts: Date.now(), text, author: { userId, name: state.name } };
  if (file) m.file = file;
  mesh?.broadcast({ t: 'msg', msg: m });
  await receiveMessage(m, false);
}

async function shareFiles(fileList) {
  if (!files) return;
  for (const file of fileList) {
    if (file.size > 4 * 1024 * 1024 * 1024) {
      toast(`${file.name} is larger than 4 GB`, 'error');
      continue;
    }
    const meta = await files.share(file);
    await sendMessage('', meta);
  }
}

async function openTextChannel(channelId, keepScroll = false) {
  if (!channelId) return;
  state.textChannel = channelId;
  state.unread.delete(channelId);
  const ch = state.channels.find((c) => c.id === channelId);
  $('chat-title').replaceChildren(icon('hash', 20), ch?.name || channelId);
  $('chat-sub').textContent = 'End-to-end peer-to-peer · history is synced between members';
  $('composer-input').placeholder = `Message #${ch?.name || channelId}`;
  renderChannels();
  renderTyping();

  const list = $('messages');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const msgs = await store.getMessages(state.serverKey, channelId).catch(() => []);
  if (state.textChannel !== channelId) return;
  list.replaceChildren(
    h('div', { class: 'empty-channel' }, h('h3', {}, `Welcome to #${ch?.name || channelId}!`), h('div', {}, 'This is the start of the channel. Messages are stored on the devices of the people here.')),
  );
  lastGroup = null;
  for (const m of msgs) appendMessage(m, false);
  if (!keepScroll || atBottom) list.scrollTop = list.scrollHeight;
}

let lastGroup = null; // {authorId, ts, el}

function appendMessage(m, scroll = true) {
  const list = $('messages');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const mentioned = m.author.userId !== userId && mentionsMe(m.text, state.name);
  const content = h('div', { class: 'msg-body' });
  if (m.text) content.append(renderText(m.text, state.name));
  if (m.file) content.append(fileCard(m));

  const grouped = lastGroup && lastGroup.authorId === m.author.userId && m.ts - lastGroup.ts < 5 * 60 * 1000 && !m.file && !lastGroup.file;
  if (grouped) {
    list.append(h('div', { class: `msg-line${mentioned ? ' mentioned' : ''}`, title: formatTime(m.ts) }, content));
  } else {
    list.append(
      h(
        'div',
        { class: `msg-group${mentioned ? ' mentioned' : ''}` },
        avatar(m.author.name, 'lg'),
        h('div', { class: 'msg-head' }, h('span', { class: 'msg-author' }, m.author.name), h('span', { class: 'msg-time' }, formatTime(m.ts))),
        content,
      ),
    );
  }
  lastGroup = { authorId: m.author.userId, ts: m.ts, file: !!m.file };
  if (scroll && (nearBottom || m.author.userId === userId)) list.scrollTop = list.scrollHeight;
}

// ---------------------------------------------------------------------------
// File cards
// ---------------------------------------------------------------------------
const fileCards = new Map(); // fileId -> Set(card api)

function fileKind(meta) {
  const t = meta.type || '';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  return 'other';
}

function fileCard(m) {
  const meta = m.file;
  const kind = fileKind(meta);
  const bar = h('div');
  const progress = h('div', { class: 'progress hidden' }, bar);
  const status = h('div', { class: 'file-size' }, formatBytes(meta.size));
  const actionBtn = h('button', { class: 'icon-btn', title: 'Download' }, icon('download'));
  const preview = h('div', { class: 'file-preview' });
  const card = h(
    'div',
    { class: 'file-card' },
    icon('file', 28),
    h('div', { class: 'file-info' }, h('div', { class: 'file-name', title: meta.name }, meta.name), status, progress),
    actionBtn,
  );
  const wrap = h('div', {}, preview, card);

  const api = {
    el: wrap,
    progress(frac) {
      if (frac == null) {
        progress.classList.add('hidden');
        status.textContent = formatBytes(meta.size);
        return;
      }
      progress.classList.toggle('hidden', frac >= 1);
      bar.style.width = `${Math.round(frac * 100)}%`;
      status.textContent = frac >= 1 ? formatBytes(meta.size) : `${formatBytes(meta.size * frac)} / ${formatBytes(meta.size)}`;
      if (frac >= 1) showReady();
    },
  };
  if (!fileCards.has(meta.id)) fileCards.set(meta.id, new Set());
  fileCards.get(meta.id).add(api);

  let ready = false;
  async function showReady() {
    if (ready) return;
    const url = await files?.urlFor(meta.id);
    if (!url) return;
    ready = true;
    actionBtn.replaceChildren(icon('save'));
    actionBtn.title = 'Save to disk';
    if (kind === 'image') preview.replaceChildren(h('img', { src: url, alt: meta.name, onclick: () => openImage(url, meta.name) }));
    if (kind === 'video') preview.replaceChildren(h('video', { src: url, controls: true, preload: 'metadata' }));
    if (kind === 'audio') preview.replaceChildren(h('audio', { src: url, controls: true, preload: 'metadata' }));
  }

  async function download() {
    if (!files) return;
    try {
      progress.classList.remove('hidden');
      await files.download(meta, m.author.userId);
    } catch (err) {
      progress.classList.add('hidden');
      status.textContent = `${formatBytes(meta.size)} — ${err.message}`;
    }
  }

  actionBtn.onclick = async () => {
    if (ready) {
      const url = await files.urlFor(meta.id);
      h('a', { href: url, download: meta.name }).click();
    } else {
      download();
    }
  };

  // Already have it locally (we sent it, or downloaded before)?
  files?.getLocal(meta.id).then((blob) => {
    if (blob) showReady();
    else if (kind !== 'other' && meta.size <= AUTO_DOWNLOAD_LIMIT) download();
  });
  if (files?.isDownloading(meta.id)) progress.classList.remove('hidden');
  return wrap;
}

function updateFileProgress(fileId, frac) {
  const set = fileCards.get(fileId);
  if (!set) return;
  for (const api of set) {
    if (!api.el.isConnected) set.delete(api);
    else api.progress(frac);
  }
}

function openImage(url, name) {
  modal({ title: name, body: h('img', { src: url, style: { maxWidth: '100%', borderRadius: '8px' } }) });
}

// Composer
const input = $('composer-input');
const autosize = () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
};
input.addEventListener('input', () => {
  autosize();
  if (Date.now() - lastTyping > 2500 && input.value.trim()) {
    lastTyping = Date.now();
    mesh?.broadcast({ t: 'typing', channel: state.textChannel });
  }
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize();
    lastTyping = 0;
    sendMessage(text.slice(0, MAX_MESSAGE));
  }
});
input.addEventListener('paste', (e) => {
  const pasted = [...(e.clipboardData?.files || [])];
  if (pasted.length) {
    e.preventDefault();
    shareFiles(pasted);
  }
});
$('btn-attach').append(icon('plusCircle', 22));
$('btn-attach').onclick = () => $('file-input').click();
$('file-input').onchange = (e) => {
  shareFiles([...e.target.files]);
  e.target.value = '';
};

// Drag & drop
let dragDepth = 0;
const chat = $('chat');
chat.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  $('drop-overlay').classList.remove('hidden');
});
chat.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop-overlay').classList.add('hidden');
});
chat.addEventListener('dragover', (e) => e.preventDefault());
chat.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').classList.add('hidden');
  const dropped = [...(e.dataTransfer?.files || [])];
  if (dropped.length) shareFiles(dropped);
});
// Never let a stray drop navigate the window away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function showMain() {
  $('connect-view').classList.add('hidden');
  $('main-view').classList.remove('hidden');
  $('main-view').classList.toggle('no-members', !state.membersVisible);
}

function renderAll() {
  $('server-name').textContent = state.serverName;
  $('host-badge').classList.toggle('hidden', !state.hosting);
  renderChannels();
  renderMembers();
  renderVoicePanel();
  renderSelf();
}

function renderVoiceState() {
  renderChannels();
  renderMembers();
  renderVoicePanel();
  renderSelf();
}

function allMembers() {
  const self = { id: state.selfId, userId, name: state.name, voice: state.voice, muted: state.muted, deafened: state.deafened, self: true };
  return [self, ...state.peers.values()];
}

function isSpeaking(member) {
  if (member.self) return audio.transmitting && !!state.voice;
  return !!mesh?.peers.get(member.id)?.speaking;
}

function renderChannels() {
  const list = $('channel-list');
  const text = state.channels.filter((c) => c.type === 'text');
  const voice = state.channels.filter((c) => c.type === 'voice');
  const members = allMembers();

  const section = (label, type) =>
    h(
      'div',
      { class: 'channel-section' },
      label,
      h('button', { class: 'icon-btn', title: `Create ${type} channel`, onclick: () => createChannel(type) }, icon('plus', 16)),
    );

  const deleteBtn = (c) =>
    h(
      'button',
      {
        class: 'icon-btn del',
        title: 'Delete channel',
        onclick: async (e) => {
          e.stopPropagation();
          if (await confirmModal('Delete channel', `Delete "${c.name}" for everyone on this server?`, 'Delete', true)) {
            signaling.send({ type: 'channel-delete', id: c.id });
          }
        },
      },
      icon('trash', 14),
    );

  list.replaceChildren(
    section('Text channels', 'text'),
    ...text.map((c) => {
      const unread = state.unread.get(c.id) || 0;
      return h(
        'div',
        {
          class: `channel${c.id === state.textChannel ? ' selected' : ''}${unread ? ' unread' : ''}`,
          onclick: () => openTextChannel(c.id),
          dataset: { channel: c.id },
        },
        icon('hash', 18),
        h('span', { class: 'name' }, c.name),
        unread ? h('span', { class: 'unread-count' }, unread > 99 ? '99+' : unread) : null,
        deleteBtn(c),
      );
    }),
    section('Voice channels', 'voice'),
    ...voice.flatMap((c) => {
      const inside = members.filter((m) => m.voice === c.id);
      return [
        h(
          'div',
          { class: `channel${c.id === state.voice ? ' selected' : ''}`, onclick: () => joinVoice(c.id), title: 'Join voice channel', dataset: { voice: c.id } },
          icon('speaker', 18),
          h('span', { class: 'name' }, c.name),
          deleteBtn(c),
        ),
        inside.length
          ? h(
              'div',
              { class: 'voice-members' },
              ...inside.map((m) =>
                h(
                  'div',
                  { class: 'voice-member', dataset: { member: m.id }, onclick: (e) => openMemberPopover(e.currentTarget, m) },
                  avatar(m.name, 'sm', isSpeaking(m)),
                  h('span', { class: 'name' }, m.name),
                  h('span', { class: 'status-icons' }, m.muted ? icon('micOff', 14) : null, m.deafened ? icon('headphonesOff', 14) : null),
                ),
              ),
            )
          : null,
      ].filter(Boolean);
    }),
  );
}

/** Cheap update of speaking rings without re-rendering lists. */
function renderSpeaking() {
  for (const m of allMembers()) {
    const speaking = isSpeaking(m);
    document.querySelectorAll(`[data-member="${CSS.escape(m.id || '')}"] .avatar`).forEach((el) => el.classList.toggle('speaking', speaking));
  }
  renderSelf();
}

function renderMembers() {
  const el = $('members');
  const members = allMembers();
  const voiceName = (id) => state.channels.find((c) => c.id === id)?.name;
  el.replaceChildren(
    h('h4', {}, `Online — ${members.length}`),
    ...members.map((m) => {
      const peer = m.self ? null : mesh?.peers.get(m.id);
      const connState = m.self ? 'connected' : peer?.state || 'new';
      const av = avatar(m.name, '', isSpeaking(m));
      av.append(h('span', { class: `dot ${connState}`, title: m.self ? 'You' : `Peer connection: ${connState}` }));
      return h(
        'div',
        { class: 'member', dataset: { member: m.id }, onclick: (e) => openMemberPopover(e.currentTarget, m) },
        av,
        h(
          'div',
          { class: 'meta' },
          h('div', { class: 'name' }, m.name, m.self ? h('span', { class: 'muted' }, ' (you)') : null),
          h('div', { class: 'sub' }, m.voice ? `🔊 ${voiceName(m.voice) || ''}${m.muted ? ' · muted' : ''}${m.deafened ? ' · deafened' : ''}` : connState === 'connected' ? 'Online' : `P2P: ${connState}`),
        ),
      );
    }),
  );
}

function renderVoicePanel() {
  const panel = $('voice-panel');
  panel.classList.toggle('hidden', !state.voice);
  if (!state.voice) return;
  const ch = state.channels.find((c) => c.id === state.voice);
  $('vp-channel').textContent = `${ch?.name || ''} / ${state.serverName}`;
}

function renderSelf() {
  const av = $('self-avatar');
  av.replaceWith(Object.assign(avatar(state.name, '', audio.transmitting && !!state.voice), { id: 'self-avatar' }));
  $('self-name').textContent = state.name;
  const sub = $('self-sub');
  let text;
  if (!state.voice) text = 'Not in voice';
  else if (state.deafened) text = 'Deafened';
  else if (state.muted) text = 'Muted';
  else if (settings.inputMode === 'ptt') text = `Push to talk: ${describeBinding(settings.pttBinding)}`;
  else if (settings.inputMode === 'vad') text = 'Voice activity';
  else text = 'Open mic';
  sub.textContent = text;
  sub.classList.toggle('tx', audio.transmitting && !!state.voice);
  $('btn-mute').replaceChildren(icon(state.muted || state.deafened ? 'micOff' : 'mic'));
  $('btn-mute').classList.toggle('active-red', state.muted || state.deafened);
  $('btn-deafen').replaceChildren(icon(state.deafened ? 'headphonesOff' : 'headphones'));
  $('btn-deafen').classList.toggle('active-red', state.deafened);
}

function renderTyping() {
  const now = Date.now();
  const names = [];
  for (const [key, t] of state.typing) {
    if (t.until < now) state.typing.delete(key);
    else if (t.channel === state.textChannel) names.push(t.name);
  }
  $('typing').textContent = names.length ? `${names.slice(0, 3).join(', ')} ${names.length > 1 ? 'are' : 'is'} typing…` : '';
}
setInterval(renderTyping, 1000);

async function createChannel(type) {
  const name = await promptModal(type === 'voice' ? 'Create voice channel' : 'Create text channel', 'Channel name');
  if (name) signaling.send({ type: 'channel-create', name, channelType: type });
}

// Member popover: volume, local mute, live connection stats
function openMemberPopover(anchor, member) {
  if (member.self) {
    openSettings(appCtx, 'audio');
    return;
  }
  const peer = mesh?.peers.get(member.id);
  const volumes = prefs.get('volumes', {});
  const vol = Math.round((volumes[member.userId] ?? 1) * 100);
  const volLabel = h('span', {}, `${vol}%`);
  const statsEl = h('dl', { class: 'stats-grid' });
  const localMuted = mesh?.localMutes.has(member.userId);

  const content = h(
    'div',
    {},
    h('div', { class: 'row', style: { alignItems: 'center', marginBottom: '12px' } }, avatar(member.name, 'lg'), h('h3', {}, member.name)),
    h('div', { class: 'setting' }, h('div', { class: 'label' }, 'User volume', volLabel),
      h('input', {
        type: 'range',
        min: 0,
        max: 100,
        value: vol,
        oninput: (e) => {
          const v = Number(e.target.value) / 100;
          volLabel.textContent = `${e.target.value}%`;
          mesh?.setUserVolume(member.userId, v);
          const all = prefs.get('volumes', {});
          all[member.userId] = v;
          prefs.set('volumes', all);
        },
      }),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: localMuted,
        onchange: (e) => {
          mesh?.setUserLocalMute(member.userId, e.target.checked);
          prefs.set('localMutes', [...(mesh?.localMutes || [])]);
        },
      }),
      h('div', {}, 'Mute for me'),
    ),
    h('div', { class: 'label muted small', style: { marginTop: '8px', fontWeight: 700 } }, 'CONNECTION'),
    statsEl,
  );

  const fmt = (v, unit, digits = 0) => (v == null || Number.isNaN(v) ? '—' : `${v.toFixed(digits)} ${unit}`);
  const refresh = async () => {
    if (!peer) {
      statsEl.replaceChildren(h('dt', {}, 'Status'), h('dd', {}, 'no connection'));
      return;
    }
    const s = await peer.getStats().catch(() => null);
    if (!s) return;
    statsEl.replaceChildren(
      h('dt', {}, 'Status'),
      h('dd', {}, peer.state),
      h('dt', {}, 'Path'),
      h('dd', {}, s.path || '—'),
      h('dt', {}, 'Round trip'),
      h('dd', {}, fmt(s.rttMs, 'ms')),
      h('dt', {}, 'Receiving'),
      h('dd', {}, fmt(s.inKbps, 'kbps')),
      h('dt', {}, 'Sending'),
      h('dd', {}, fmt(s.outKbps, 'kbps')),
      h('dt', {}, 'Packet loss'),
      h('dd', {}, fmt(s.lossPct, '%', 1)),
      h('dt', {}, 'Network jitter'),
      h('dd', {}, fmt(s.jitterMs, 'ms', 1)),
      h('dt', {}, 'Jitter buffer'),
      h('dd', {}, fmt(s.bufferMs, 'ms')),
      h('dt', {}, 'Codec in'),
      h('dd', { title: s.codec || '' }, s.codec || '—'),
      h('dt', {}, 'Encoder'),
      h('dd', { title: s.sendCodec || '' }, s.sendCodec || '—'),
    );
  };
  refresh();
  const timer = setInterval(refresh, 1000);
  popover(anchor, content, () => clearInterval(timer));
}

function openServerInfo() {
  const body = h('div');
  const copyRow = (text) =>
    h(
      'div',
      { class: 'copy-row' },
      h('span', {}, text),
      h(
        'button',
        {
          class: 'icon-btn',
          title: 'Copy',
          onclick: () => {
            navigator.clipboard.writeText(text);
            toast('Copied');
          },
        },
        icon('copy', 16),
      ),
    );
  const render = async () => {
    const status = state.hosting ? await window.voice.serverStatus() : null;
    body.replaceChildren(
      h('div', { class: 'setting' }, h('div', { class: 'label' }, 'Connected to'), copyRow(signaling.url || '')),
      status?.running
        ? h(
            'div',
            {},
            h('div', { class: 'setting' }, h('div', { class: 'label' }, 'Share one of these addresses'),
              ...status.addresses.map((a) => copyRow(`${a}:${status.port}`)),
              h('div', { class: 'hint' },
                'Same network: use the address above. Over the internet: forward TCP port ',
                h('strong', {}, String(status.port)),
                ' on your router to this PC and share your public IP. Only the small signaling connection uses this port — voice, chat and files go directly between peers.',
              ),
            ),
            h('div', { class: 'setting' }, h('div', { class: 'label' }, 'Server log'), h('div', { class: 'log' }, status.log.join('\n') || '—')),
          )
        : null,
    );
  };
  render();
  const leaveBtn = h('button', { class: 'btn danger' }, state.hosting ? 'Stop server & leave' : 'Leave server');
  const m = modal({ title: state.serverName, small: true, body, footer: [leaveBtn] });
  leaveBtn.onclick = () => {
    m.close();
    leaveServer();
  };
}

// Static buttons
$('btn-leave-voice').append(icon('hangup'));
$('btn-leave-voice').onclick = () => leaveVoice();
$('btn-mute').onclick = () => setMuted(!state.muted);
$('btn-deafen').onclick = () => setDeafened(!state.deafened);
$('btn-settings').append(icon('settings'));
$('btn-settings').onclick = () => openSettings(appCtx);
$('server-header').onclick = openServerInfo;
$('btn-toggle-members').append(icon('users'));
$('btn-toggle-members').onclick = () => {
  state.membersVisible = !state.membersVisible;
  prefs.set('membersVisible', state.membersVisible);
  $('main-view').classList.toggle('no-members', !state.membersVisible);
};
window.addEventListener('resize', debounce(closePopover, 100));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  state.appInfo = await window.voice.info();
  sfx.enabled = settings.sounds;
  sfx.setSink(settings.outputDeviceId);
  audio.setMuted(state.muted);
  audio.setDeafened(state.deafened);
  await bindPtt();
  renderConnect();
  if (settings.notifications && Notification.permission === 'default') Notification.requestPermission();

  // Automation / power users: --voice-name=… --voice-connect=host:port --voice-host[=port]
  const arg = (k) => state.appInfo.args.find((a) => a === `--voice-${k}` || a.startsWith(`--voice-${k}=`))?.split('=').slice(1).join('=');
  const argName = arg('name');
  if (argName) {
    state.name = argName;
    $('cv-name').value = argName;
  }
  const hostArg = state.appInfo.args.find((a) => a.startsWith('--voice-host'));
  const connectArg = arg('connect');
  try {
    if (hostArg) {
      $('hv-port').value = hostArg.includes('=') ? hostArg.split('=')[1] : 9987;
      $('host-form').requestSubmit();
    } else if (connectArg) {
      await connect(connectArg, arg('password') || '', { remember: false });
    }
  } catch (err) {
    console.warn('auto-connect failed', err);
  }
}

boot();

// Exposed for debugging / automated tests.
window.__voice = { state, settings, audio, get mesh() { return mesh; }, get files() { return files; }, joinVoice, leaveVoice, sendMessage, shareFiles, openTextChannel };
