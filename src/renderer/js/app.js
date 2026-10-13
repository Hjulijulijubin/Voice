import { h, prefs, formatTime, formatBytes, colorFor, initials, debounce } from './util.js';
import { icon } from './icons.js';
import { toast, modal, promptModal, confirmModal, popover, closePopover } from './ui.js';
import { AudioEngine, Sfx } from './audio.js';
import { MediaEngine } from './media.js';
import { Room, newRoomRecord } from './room.js';
import { store } from './store.js';
import { createInvite, parseInvite } from './crypto.js';
import { renderText, mentionsMe } from './richtext.js';
import { loadSettings, saveSettings, openSettings, parseIceServers, describeBinding } from './settings.js';

const $ = (id) => document.getElementById(id);
const MAX_MESSAGE = 4000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const settings = loadSettings();
const state = {
  name: prefs.get('name', ''),
  muted: prefs.get('muted', false),
  deafened: prefs.get('deafened', false),
  membersVisible: prefs.get('membersVisible', true),
  textChannel: prefs.get('textChannels', {}), // roomId -> channel id
  appInfo: { globalPtt: false, platform: 'linux', args: [], hardwareAcceleration: true },
  globalPttActive: false,
  rvStatus: { relays: [], lan: false },
};
/** @type {Map<string, Room>} */
const rooms = new Map();
let current = null; // room on screen
let voiceRoom = null; // room whose voice channel we're in
let voiceChannel = null;
let lastTyping = 0;

const audio = new AudioEngine(settings);
const media = new MediaEngine(audio, settings);
const sfx = new Sfx();

const roomCtx = {
  settings,
  getName: () => state.name,
  extraIce: () => parseIceServers(settings.iceServers),
  onAudioPacket: (room, payload) => {
    if (room === voiceRoom && !state.deafened) media.onPacket(payload);
  },
  onCustomRoutes: (room, n) => {
    if (room === voiceRoom) media.setSending(n > 0);
  },
};

// ---------------------------------------------------------------------------
// Settings dialog context
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
  get hardwareAcceleration() {
    return state.appInfo.hardwareAcceleration;
  },
  requestMediaAccess: () => window.voice.requestMediaAccess(),
  async ensureMic() {
    if (audio.running) return;
    await window.voice.requestMediaAccess();
    await audio.start();
  },
  releaseMicIfIdle() {
    if (!voiceRoom && audio.running && !audio.loopbackActive) audio.stop();
  },
  async restartMic() {
    try {
      await audio.restart();
    } catch (err) {
      toast(`Microphone error: ${err.message}`, 'error');
    }
  },
  applyOutput() {
    for (const r of rooms.values()) r.overlay.setOutputDevice(settings.outputDeviceId);
    media.setOutputDevice(settings.outputDeviceId);
    sfx.setSink(settings.outputDeviceId);
  },
  applyQuality() {
    for (const r of rooms.values()) r.overlay.applyQuality();
    media.applySettings();
  },
  applyJitterTarget() {
    for (const r of rooms.values()) r.overlay.applyJitterTarget();
    media.applySettings();
  },
  applyMode() {
    media.applySettings();
    for (const r of rooms.values()) r.overlay._recomputeRoutes();
  },
  applyNetwork() {
    window.voice.rendezvous.configure({ relays: settings.relays, lan: settings.lan });
    for (const r of rooms.values()) r.overlay.setRelayAllowed(settings.allowRelay);
  },
  bindPtt,
  renderSelf,
  applyMisc() {
    sfx.enabled = settings.sounds;
  },
  setName(name) {
    state.name = name.slice(0, 32);
    prefs.set('name', state.name);
    for (const r of rooms.values()) r.setName(state.name);
    renderSelf();
    renderMembers();
  },
};

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
async function startRoom(record) {
  const room = new Room(record, roomCtx);
  rooms.set(record.roomId, room);
  room.on('messages', (msgs, live) => onMessages(room, msgs, live));
  room.on('state', () => {
    if (room === current) {
      renderChannels();
      renderHeader();
      if (!room.channels.some((c) => c.id === state.textChannel[room.id])) openTextChannel(currentChannel());
    }
    if (room === voiceRoom && !room.channels.some((c) => c.id === voiceChannel)) leaveVoice();
    renderRail();
  });
  room.on('roster', () => onRoster(room));
  room.on('speaking', () => room === current && renderSpeaking());
  room.on('typing', () => room === current && renderTyping());
  room.on('holders', (fileId) => room === current && updateFileCards(fileId));
  room.on('progress', (fileId, frac) => room === current && updateFileProgress(fileId, frac));
  room.on('uploads', (n) => {
    if (room !== current) return;
    $('upload-indicator').classList.toggle('hidden', n === 0);
    $('upload-indicator').textContent = n ? `Sending files to ${n} member${n > 1 ? 's' : ''}…` : '';
  });
  await room.start();
  room.overlay.setOutputDevice(settings.outputDeviceId);
  for (const [id, v] of Object.entries(prefs.get('volumes', {}))) room.overlay.setUserVolume(id, v);
  for (const id of prefs.get('localMutes', [])) room.overlay.setUserLocalMute(id, true);
  return room;
}

async function createRoom(name) {
  const { secret, code } = createInvite();
  const record = await newRoomRecord(secret, name);
  await store.putRoom(record);
  const room = await startRoom(record);
  await room.applyOp({ kind: 'name', value: name });
  await room.applyOp({ kind: 'channel-add', cid: 'random', name: 'random', type: 'text' });
  await room.applyOp({ kind: 'channel-add', cid: 'gaming', name: 'Gaming', type: 'voice' });
  await room.applyOp({ kind: 'channel-add', cid: 'hifi', name: 'Music (Hi-Fi)', type: 'voice' });
  selectRoom(room);
  return { room, code };
}

async function joinRoom(code) {
  const secret = parseInvite(code);
  const record = await newRoomRecord(secret, '');
  if (rooms.has(record.roomId)) {
    selectRoom(rooms.get(record.roomId));
    return rooms.get(record.roomId);
  }
  await store.putRoom(record);
  const room = await startRoom(record);
  selectRoom(room);
  sfx.play('connect');
  return room;
}

async function leaveRoom(room) {
  if (room === voiceRoom) leaveVoice();
  // Our copies are deleted: un-announce them so "deleted by everyone" still works.
  await room.files.releaseAll().catch(() => {});
  room.stop();
  rooms.delete(room.id);
  await store.deleteRoom(room.id);
  await window.voice.files.removeRoom(room.id);
  if (current === room) {
    current = null;
    const next = rooms.values().next().value;
    if (next) selectRoom(next);
    else showWelcome();
  }
  renderRail();
}

function selectRoom(room) {
  current = room;
  prefs.set('lastRoom', room.id);
  showMain();
  renderAll();
  openTextChannel(currentChannel());
}

function currentChannel() {
  if (!current) return null;
  const saved = state.textChannel[current.id];
  return current.channels.some((c) => c.id === saved && c.type === 'text') ? saved : current.channels.find((c) => c.type === 'text')?.id;
}

let voiceMembersBefore = new Set();
function onRoster(room) {
  if (room === voiceRoom) {
    const now = new Set(room.overlay.roster().filter((m) => m.info.voice === voiceChannel).map((m) => m.id));
    if ([...now].some((id) => !voiceMembersBefore.has(id))) sfx.play('join');
    else if ([...voiceMembersBefore].some((id) => !now.has(id))) sfx.play('leave');
    voiceMembersBefore = now;
  }
  if (room === current) {
    renderMembers();
    renderChannels();
    renderHeader();
  }
}

// ---------------------------------------------------------------------------
// Welcome screen
// ---------------------------------------------------------------------------
function showWelcome(closable = false) {
  $('main-view').classList.add('hidden');
  $('welcome-view').classList.remove('hidden');
  $('welcome-close').classList.toggle('hidden', !closable);
  $('wv-name').value = state.name;
  $('welcome-error').textContent = '';
  ($('wv-name').value ? $('cv-room') : $('wv-name')).focus();
}

function showMain() {
  $('welcome-view').classList.add('hidden');
  $('main-view').classList.remove('hidden');
  $('main-view').classList.toggle('no-members', !state.membersVisible);
}

function readName() {
  const name = $('wv-name').value.trim();
  if (!name) {
    $('welcome-error').textContent = 'Please choose a display name first.';
    $('wv-name').focus();
    return false;
  }
  if (name !== state.name) appCtx.setName(name);
  return true;
}

$('welcome-close').append(icon('x'));
$('welcome-close').onclick = () => current && showMain();

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!readName()) return;
  try {
    const { code } = await createRoom($('cv-room').value.trim() || `${state.name}'s room`);
    $('cv-room').value = '';
    showInvite(code, true);
  } catch (err) {
    $('welcome-error').textContent = err.message;
  }
});

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!readName()) return;
  try {
    await joinRoom($('jv-code').value);
    $('jv-code').value = '';
  } catch (err) {
    $('welcome-error').textContent = err.message;
  }
});

window.voice.onInvite(async (code) => {
  if (!state.name) {
    showWelcome(!!current);
    $('jv-code').value = code;
    return;
  }
  try {
    await joinRoom(code);
  } catch (err) {
    toast(err.message, 'error');
  }
});

function showInvite(code, fresh = false) {
  const body = h(
    'div',
    {},
    h('p', {}, fresh ? 'Your room is ready. Send this invite code to your friends through any other chat:' : 'Anyone with this code can join the room:'),
    h('div', { class: 'copy-row' }, h('span', { class: 'invite-code' }, code), h('button', { class: 'icon-btn', title: 'Copy', onclick: () => copy(code) }, icon('copy', 16))),
    h(
      'p',
      { class: 'hint muted small' },
      'The code is the room key: it lets people in and decrypts everything. Only share it with people you trust. There is no server and no account — the room lives on the devices of its members.',
    ),
  );
  modal({ title: 'Invite people', small: true, body, footer: [h('button', { class: 'btn primary', onclick: () => copy(code) }, 'Copy invite code')] });
}

function copy(text) {
  navigator.clipboard.writeText(text);
  toast('Copied to clipboard');
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------
async function joinVoice(channelId) {
  if (!current || (voiceRoom === current && voiceChannel === channelId)) return;
  try {
    await appCtx.ensureMic();
  } catch (err) {
    toast(`Cannot access microphone: ${err.message}`, 'error', 7000);
    return;
  }
  if (voiceRoom && voiceRoom !== current) leaveVoice({ silent: true, keepMic: true });
  voiceRoom = current;
  voiceChannel = channelId;
  const ov = voiceRoom.overlay;
  media.setRoom(ov, voiceRoom.keys.mediaKeyRaw, voiceRoom.selfId);
  media.setDeafened(state.deafened);
  audio.setMuted(state.muted);
  audio.setDeafened(state.deafened);
  ov.setDeafened(state.deafened);
  ov.setLocalTrack(audio.track);
  ov.setInfo({ muted: state.muted, deafened: state.deafened });
  ov.setVoiceChannel(channelId);
  voiceMembersBefore = new Set(ov.roster().filter((m) => m.info.voice === channelId).map((m) => m.id));
  sfx.play('join');
  renderVoiceState();
}

function leaveVoice({ silent = false, keepMic = false } = {}) {
  if (!voiceRoom) return;
  const ov = voiceRoom.overlay;
  ov.setVoiceChannel(null);
  ov.setLocalTrack(null);
  media.setSending(false);
  media.shutdown();
  voiceRoom = null;
  voiceChannel = null;
  if (!keepMic && !audio.loopbackActive) audio.stop();
  if (!silent) sfx.play('leave');
  renderVoiceState();
}

function setMuted(muted) {
  if (!muted && state.deafened) return setDeafened(false);
  state.muted = muted;
  prefs.set('muted', muted);
  audio.setMuted(muted);
  voiceRoom?.overlay.setInfo({ muted });
  sfx.play(muted ? 'mute' : 'unmute');
  renderVoiceState();
}

function setDeafened(deafened) {
  state.deafened = deafened;
  prefs.set('deafened', deafened);
  audio.setDeafened(deafened);
  media.setDeafened(deafened);
  voiceRoom?.overlay.setDeafened(deafened);
  voiceRoom?.overlay.setInfo({ deafened });
  sfx.play(deafened ? 'mute' : 'unmute');
  renderVoiceState();
}

async function bindPtt() {
  state.globalPttActive = await window.voice.bindPtt(settings.inputMode === 'ptt' ? settings.pttBinding : null);
  renderSelf();
}

function matchesBinding(e) {
  const b = settings.pttBinding;
  if (!b || settings.inputMode !== 'ptt') return false;
  return b.type === 'key' ? e.code === b.code : e.button === b.button;
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyM') {
    e.preventDefault();
    return setMuted(!state.muted);
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    return setDeafened(!state.deafened);
  }
  if (e.repeat || !matchesBinding(e)) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (typing && /^(Key|Digit|Space)/.test(e.code) && !state.globalPttActive) return;
  audio.setPtt(true);
});
window.addEventListener('keyup', (e) => matchesBinding(e) && audio.setPtt(false));
window.addEventListener('mousedown', (e) => e.button > 0 && matchesBinding(e) && audio.setPtt(true));
window.addEventListener('mouseup', (e) => e.button > 0 && matchesBinding(e) && audio.setPtt(false));
window.addEventListener('blur', () => !state.globalPttActive && audio.setPtt(false));
window.voice.onPtt((down) => audio.setPtt(down));

audio.on('transmitting', () => renderSpeaking());
audio.on('device-lost', () => {
  toast('Microphone disconnected — switching to the default device.', 'error');
  settings.inputDeviceId = '';
  saveSettings(settings);
  appCtx.restartMic();
});
audio.on('track', (track) => {
  voiceRoom?.overlay.setLocalTrack(track);
  if (track) media.onMicRestart();
});

// Voice panel summary; only computed while in voice and visible.
setInterval(() => {
  if (!voiceRoom || document.hidden) return;
  const ov = voiceRoom.overlay;
  const listeners = ov.roster().filter((m) => m.info.voice === voiceChannel);
  if (!listeners.length) {
    $('vp-status').textContent = 'Voice Connected';
    $('vp-status').classList.remove('warn');
    $('vp-stats').textContent = 'Alone in channel';
    return;
  }
  const routes = listeners.map((m) => ov.audioRoutes.get(m.id) || { mode: 'none' });
  const reachable = routes.filter((r) => r.mode !== 'none');
  const relayed = reachable.filter((r) => r.mode === 'relay' && r.path.length > 1).length;
  const worst = reachable.length ? Math.max(...reachable.map((r) => r.cost ?? 0)) : 0;
  const unreachable = routes.length - reachable.length;
  $('vp-status').classList.toggle('warn', unreachable > 0);
  $('vp-status').textContent = unreachable ? `${unreachable} connecting…` : 'Voice Connected';
  const parts = [`≤ ${Math.round(worst)} ms network`];
  if (relayed) parts.push(`${relayed} via relay`);
  if (settings.audioMode === 'ultra') parts.push(`ultra ${settings.ultraFrameMs} ms`);
  $('vp-stats').textContent = parts.join(' · ');
}, 2000);

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
async function onMessages(room, msgs, live) {
  if (room === current) {
    const ch = currentChannel();
    const here = msgs.filter((m) => m.channel === ch).sort((a, b) => a.ts - b.ts);
    // History arriving from a sync may belong anywhere in the timeline.
    if (!live && here.length > 1) await openTextChannel(ch, true);
    else here.forEach((m) => appendMessage(m));
    renderTyping();
  }
  for (const m of msgs) {
    const mine = m.author.id === room.selfId;
    if (!mine && !(room === current && m.channel === currentChannel())) room.unread.set(m.channel, (room.unread.get(m.channel) || 0) + 1);
    if (!live || mine) continue;
    const mentioned = mentionsMe(m.text, state.name);
    if (mentioned || !document.hasFocus()) {
      if (settings.sounds) sfx.play('message');
      window.voice.attention();
    }
    if (mentioned && settings.notifications && !document.hasFocus()) {
      new Notification(`${m.author.name} in ${room.name}`, { body: m.text.slice(0, 200), silent: true });
    }
  }
  renderRail();
  if (room === current) renderChannels();
}

async function openTextChannel(channelId, keepScroll = false) {
  if (!current || !channelId) return;
  const room = current;
  state.textChannel[room.id] = channelId;
  prefs.set('textChannels', state.textChannel);
  room.unread.delete(channelId);
  const ch = room.channels.find((c) => c.id === channelId);
  $('chat-title').replaceChildren(icon('hash', 20), ch?.name || channelId);
  $('chat-sub').textContent = 'End-to-end encrypted · stored only on members’ devices';
  $('composer-input').placeholder = `Message #${ch?.name || channelId}`;
  renderChannels();
  renderRail();
  renderTyping();
  const list = $('messages');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const fromBottom = list.scrollHeight - list.scrollTop;
  if (histState.channel !== `${room.id}/${channelId}`) histState.limit = HISTORY_PAGE;
  histState.channel = `${room.id}/${channelId}`;
  const msgs = await store.getMessages(room.id, channelId, histState.limit);
  histState.complete = msgs.length < histState.limit;
  if (current !== room || currentChannel() !== channelId) return;
  fileCards.clear();
  list.replaceChildren(
    h(
      'div',
      { class: 'empty-channel' },
      h('h3', {}, `Welcome to #${ch?.name || channelId}!`),
      h('div', {}, 'Messages are signed by their authors, end-to-end encrypted and stored only on the devices of the people in this room.'),
    ),
  );
  lastGroup = null;
  for (const m of msgs) appendMessage(m, false);
  if (keepScroll === 'older') list.scrollTop = list.scrollHeight - fromBottom;
  else if (!keepScroll || atBottom) list.scrollTop = list.scrollHeight;
}

// Load older messages when scrolling to the top (pages of 150).
const HISTORY_PAGE = 150;
const histState = { channel: null, limit: HISTORY_PAGE, complete: true, loading: false };
$('messages').addEventListener('scroll', async (e) => {
  if (e.target.scrollTop > 40 || histState.complete || histState.loading || !current) return;
  histState.loading = true;
  histState.limit += HISTORY_PAGE;
  await openTextChannel(currentChannel(), 'older');
  histState.loading = false;
});

let lastGroup = null;

function appendMessage(m, scroll = true) {
  const room = current;
  const list = $('messages');
  // A file nobody keeps any more disappears from the chat.
  if (m.file && !m.text && room.files.isGone(m.file.id)) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const mine = m.author.id === room.selfId;
  const mentioned = !mine && mentionsMe(m.text, state.name);
  const content = h('div', { class: 'msg-body' });
  if (m.text) content.append(renderText(m.text, state.name));
  if (m.file) content.append(fileCard(room, m));
  const grouped = lastGroup && lastGroup.author === m.author.id && m.ts - lastGroup.ts < 300000 && !m.file && !lastGroup.file;
  const el = grouped
    ? h('div', { class: `msg-line${mentioned ? ' mentioned' : ''}`, title: formatTime(m.ts), dataset: { msg: m.id } }, content)
    : h(
        'div',
        { class: `msg-group${mentioned ? ' mentioned' : ''}`, dataset: { msg: m.id } },
        memberAvatar(m.author.id, m.author.name, 'lg'),
        h('div', { class: 'msg-head' }, h('span', { class: 'msg-author', style: { color: colorFor(m.author.id) } }, m.author.name), h('span', { class: 'msg-time' }, formatTime(m.ts))),
        content,
      );
  list.append(el);
  lastGroup = { author: m.author.id, ts: m.ts, file: !!m.file };
  if (scroll && (nearBottom || mine)) list.scrollTop = list.scrollHeight;
}

function memberAvatar(id, name, size = '', speaking = false) {
  return h('div', { class: `avatar ${size}${speaking ? ' speaking' : ''}`, style: { background: colorFor(id) }, title: `${name} · ${id.slice(0, 8)}` }, initials(name));
}

// ---------------------------------------------------------------------------
// File cards
// ---------------------------------------------------------------------------
const fileCards = new Map(); // fileId -> Set(card api)

function fileKind(type = '') {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return 'other';
}

function fileCard(room, m) {
  const meta = m.file;
  const files = room.files;
  const wrap = h('div', { class: 'file-wrap', dataset: { file: meta.id } });
  const bar = h('div');
  const progress = h('div', { class: 'progress hidden' }, bar);
  const status = h('div', { class: 'file-size' });
  const holdersEl = h('div', { class: 'file-holders' });
  const actions = h('div', { class: 'file-actions' });
  const preview = h('div', { class: 'file-preview' });
  const card = h(
    'div',
    { class: 'file-card' },
    icon('file', 28),
    h('div', { class: 'file-info' }, h('div', { class: 'file-name', title: meta.name }, meta.name), status, holdersEl, progress),
    actions,
  );
  wrap.append(preview, card);
  let shownPreview = false;
  const btn = (name, title, fn) => h('button', { class: 'icon-btn', title, onclick: fn }, icon(name, 18));

  const update = () => {
    if (files.isGone(meta.id)) {
      // Everyone deleted it: it disappears from the chat.
      const msgEl = wrap.closest('[data-msg]');
      if (msgEl && !m.text) msgEl.remove();
      else wrap.replaceChildren(h('div', { class: 'muted small' }, `${meta.name} was deleted by everyone`));
      return;
    }
    const local = files.hasLocal(meta.id);
    const holders = files.holdersOf(meta.id).length;
    const downloading = files.downloads.has(meta.id);
    if (!downloading) status.textContent = formatBytes(meta.size);
    holdersEl.textContent = `Stored on ${holders} device${holders === 1 ? '' : 's'}${local ? ' (incl. this PC)' : ''}`;
    progress.classList.toggle('hidden', !downloading);
    const buttons = [];
    if (local) {
      buttons.push(btn('save', 'Save a copy…', () => window.voice.files.saveAs(room.id, meta.id, meta.name)));
      buttons.push(btn('external', 'Open', () => window.voice.files.open(room.id, meta.id, meta.name)));
      buttons.push(
        btn('trash', 'Delete from this PC', async () => {
          const last = holders <= 1;
          const ok = await confirmModal(
            'Delete file from this PC',
            last
              ? `You are the last member storing "${meta.name}". Deleting it removes it from the chat for everyone.`
              : `"${meta.name}" stays available from the ${holders - 1} other member(s) who store it.`,
            'Delete',
            true,
          );
          if (ok) await files.deleteLocal(meta.id);
          update();
        }),
      );
    } else if (!downloading) {
      buttons.push(
        btn('download', holders ? 'Download to this PC' : 'Nobody online has this file', () => {
          files.download(meta).catch((err) => toast(err.message, 'error'));
          update();
        }),
      );
    }
    actions.replaceChildren(...buttons);
    const kind = fileKind(meta.type);
    if (local && !shownPreview && kind !== 'other') {
      shownPreview = true;
      const src = files.url(meta);
      if (kind === 'image') preview.replaceChildren(h('img', { src, alt: meta.name, loading: 'lazy', onclick: () => openImage(src, meta.name) }));
      if (kind === 'video') preview.replaceChildren(h('video', { src, controls: true, preload: 'metadata' }));
      if (kind === 'audio') preview.replaceChildren(h('audio', { src, controls: true, preload: 'none' }));
    } else if (!local && shownPreview) {
      shownPreview = false;
      preview.replaceChildren();
    }
  };
  const api = {
    update,
    progress(frac) {
      if (frac == null || frac >= 1) return update();
      progress.classList.remove('hidden');
      bar.style.width = `${Math.round(frac * 100)}%`;
      status.textContent = `${formatBytes(meta.size * frac)} / ${formatBytes(meta.size)}`;
    },
  };
  if (!fileCards.has(meta.id)) fileCards.set(meta.id, new Set());
  fileCards.get(meta.id).add(api);
  update();
  return wrap;
}

function updateFileCards(fileId) {
  for (const api of fileCards.get(fileId) || []) api.update();
}

function updateFileProgress(fileId, frac) {
  for (const api of fileCards.get(fileId) || []) api.progress(frac);
}

function openImage(src, name) {
  modal({ title: name, body: h('img', { src, style: { maxWidth: '100%', borderRadius: '8px' } }) });
}

async function shareFiles(list) {
  if (!current) return;
  const room = current;
  const channel = currentChannel();
  for (const file of list) {
    try {
      await room.shareFile(channel, file);
    } catch (err) {
      toast(`Could not share ${file.name}: ${err.message}`, 'error');
    }
  }
}

// Composer
const input = $('composer-input');
const autosize = () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
};
input.addEventListener('input', () => {
  autosize();
  if (current && Date.now() - lastTyping > 2500 && input.value.trim()) {
    lastTyping = Date.now();
    current.sendTyping(currentChannel());
  }
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !current) return;
    input.value = '';
    autosize();
    lastTyping = 0;
    current.sendMessage(currentChannel(), text.slice(0, MAX_MESSAGE));
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
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderAll() {
  renderRail();
  renderHeader();
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
  renderRail();
}

function renderRail() {
  const items = [...rooms.values()].map((room) => {
    const unread = [...room.unread.values()].some((n) => n > 0);
    return h(
      'button',
      {
        class: `rail-item${room === current ? ' active' : ''}${unread ? ' unread' : ''}`,
        style: { background: colorFor(room.id) },
        title: room.name,
        dataset: { room: room.id },
        onclick: () => selectRoom(room),
      },
      initials(room.name),
      room === voiceRoom ? h('span', { class: 'voice-badge' }) : null,
    );
  });
  $('rail').replaceChildren(
    ...items,
    h('div', { class: 'rail-sep' }),
    h('button', { class: 'rail-item rail-add', title: 'Create or join a room', onclick: () => showWelcome(!!current) }, icon('plus', 22)),
  );
}

function renderHeader() {
  if (!current) return;
  $('room-name').textContent = current.name;
  const peers = current.overlay.roster().length;
  const reachable = state.rvStatus.relays.some((r) => r.open) || state.rvStatus.lan;
  const dot = $('net-dot');
  dot.className = `net-dot ${peers ? 'ok' : reachable ? '' : 'bad'}`;
  dot.title = peers ? `${peers} member(s) online` : reachable ? 'Waiting for members…' : 'Offline: no rendezvous relay reachable and LAN discovery off';
}

function isSpeaking(room, member) {
  if (member.self) return audio.transmitting && voiceRoom === room;
  return room === voiceRoom && !!(room.overlay.peers.get(member.id)?.speaking || media.isSpeaking(member.id));
}

function renderChannels() {
  if (!current) return;
  const room = current;
  const members = room.members();
  const section = (label, type) =>
    h('div', { class: 'channel-section' }, label, h('button', { class: 'icon-btn', title: `Create ${type} channel`, onclick: () => createChannel(type) }, icon('plus', 16)));
  const del = (c) =>
    h(
      'button',
      {
        class: 'icon-btn del',
        title: 'Delete channel',
        onclick: async (e) => {
          e.stopPropagation();
          if (await confirmModal('Delete channel', `Delete "${c.name}" for everyone in this room?`, 'Delete', true)) room.applyOp({ kind: 'channel-del', cid: c.id });
        },
      },
      icon('trash', 14),
    );
  const textCh = currentChannel();
  $('channel-list').replaceChildren(
    section('Text channels', 'text'),
    ...room.channels
      .filter((c) => c.type === 'text')
      .map((c) => {
        const unread = room.unread.get(c.id) || 0;
        return h(
          'div',
          { class: `channel${c.id === textCh ? ' selected' : ''}${unread ? ' unread' : ''}`, onclick: () => openTextChannel(c.id), dataset: { channel: c.id } },
          icon('hash', 18),
          h('span', { class: 'name' }, c.name),
          unread ? h('span', { class: 'unread-count' }, unread > 99 ? '99+' : unread) : null,
          del(c),
        );
      }),
    section('Voice channels', 'voice'),
    ...room.channels
      .filter((c) => c.type === 'voice')
      .flatMap((c) => {
        const inside = members.filter((m) => m.info.voice === c.id);
        return [
          h(
            'div',
            { class: `channel${room === voiceRoom && c.id === voiceChannel ? ' selected' : ''}`, onclick: () => joinVoice(c.id), title: 'Join voice channel', dataset: { voice: c.id } },
            icon('speaker', 18),
            h('span', { class: 'name' }, c.name),
            del(c),
          ),
          inside.length
            ? h(
                'div',
                { class: 'voice-members' },
                ...inside.map((m) =>
                  h(
                    'div',
                    { class: 'voice-member', dataset: { member: m.id }, onclick: (e) => openMemberPopover(e.currentTarget, m) },
                    memberAvatar(m.id, m.info.name, 'sm', isSpeaking(room, m)),
                    h('span', { class: 'name' }, m.info.name),
                    h('span', { class: 'status-icons' }, m.info.muted ? icon('micOff', 14) : null, m.info.deafened ? icon('headphonesOff', 14) : null),
                  ),
                ),
              )
            : null,
        ].filter(Boolean);
      }),
  );
}

function renderSpeaking() {
  if (!current) return;
  for (const m of current.members()) {
    const speaking = isSpeaking(current, m);
    for (const el of document.querySelectorAll(`[data-member="${m.id}"] .avatar`)) el.classList.toggle('speaking', speaking);
  }
  renderSelf();
}

function routeLabel(m) {
  if (m.self) return 'You';
  if (m.route?.path.length > 1) {
    const via = m.route.path
      .slice(0, -1)
      .map((id) => current.overlay.ls.nodes.get(id)?.info.name || id.slice(0, 6))
      .join(' → ');
    return `via ${via} · ${Math.round(m.route.cost)} ms`;
  }
  if (m.direct) return `direct · ${m.rtt != null ? Math.round(m.rtt / 2) : '…'} ms`;
  return 'connecting…';
}

function renderMembers() {
  if (!current) return;
  const room = current;
  const voiceName = (id) => room.channels.find((c) => c.id === id)?.name;
  const members = room.members();
  $('members').replaceChildren(
    h('h4', {}, `Online — ${members.length}`),
    ...members.map((m) => {
      const av = memberAvatar(m.id, m.info.name, '', isSpeaking(room, m));
      av.append(h('span', { class: `dot ${m.self || m.direct || m.route ? 'connected' : 'connecting'}` }));
      return h(
        'div',
        { class: 'member', dataset: { member: m.id }, onclick: (e) => openMemberPopover(e.currentTarget, m) },
        av,
        h(
          'div',
          { class: 'meta' },
          h('div', { class: 'name' }, m.info.name, m.self ? h('span', { class: 'muted' }, ' (you)') : null),
          h(
            'div',
            { class: 'sub' },
            m.info.voice ? `🔊 ${voiceName(m.info.voice) || ''}${m.info.muted ? ' (muted)' : ''}${m.self ? '' : ' · '}` : '',
            m.self && m.info.voice ? null : h('span', { class: 'route-tag' }, routeLabel(m)),
          ),
        ),
      );
    }),
  );
}

function renderVoicePanel() {
  $('voice-panel').classList.toggle('hidden', !voiceRoom);
  if (!voiceRoom) return;
  const ch = voiceRoom.channels.find((c) => c.id === voiceChannel);
  $('vp-channel').textContent = `${ch?.name || ''} / ${voiceRoom.name}`;
}

function renderSelf() {
  $('self-avatar').replaceWith(Object.assign(memberAvatar(current?.selfId || 'me', state.name, '', audio.transmitting && !!voiceRoom), { id: 'self-avatar' }));
  $('self-name').textContent = state.name;
  const sub = $('self-sub');
  let text;
  if (!voiceRoom) text = 'Not in voice';
  else if (state.deafened) text = 'Deafened';
  else if (state.muted) text = 'Muted';
  else if (settings.inputMode === 'ptt') text = `Push to talk: ${describeBinding(settings.pttBinding)}`;
  else if (settings.inputMode === 'vad') text = 'Voice activity';
  else text = 'Open mic';
  sub.textContent = text;
  sub.classList.toggle('tx', audio.transmitting && !!voiceRoom);
  $('btn-mute').replaceChildren(icon(state.muted || state.deafened ? 'micOff' : 'mic'));
  $('btn-mute').classList.toggle('active-red', state.muted || state.deafened);
  $('btn-deafen').replaceChildren(icon(state.deafened ? 'headphonesOff' : 'headphones'));
  $('btn-deafen').classList.toggle('active-red', state.deafened);
}

let typingTimer = null;
function renderTyping() {
  if (!current) return;
  const now = Date.now();
  const names = [];
  for (const [id, t] of current.typing) {
    if (t.until < now) current.typing.delete(id);
    else if (t.channel === currentChannel()) names.push(t.name);
  }
  $('typing').textContent = names.length ? `${names.slice(0, 3).join(', ')} ${names.length > 1 ? 'are' : 'is'} typing…` : '';
  // Only tick while someone is typing.
  clearTimeout(typingTimer);
  if (current.typing.size) typingTimer = setTimeout(renderTyping, 1000);
}

async function createChannel(type) {
  const name = await promptModal(type === 'voice' ? 'Create voice channel' : 'Create text channel', 'Channel name');
  if (!name || !current) return;
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'channel';
  current.applyOp({ kind: 'channel-add', cid: `${base}-${Math.random().toString(36).slice(2, 6)}`, name, type });
}

function openMemberPopover(anchor, member) {
  if (member.self) return openSettings(appCtx, 'audio');
  const ov = current.overlay;
  const volumes = prefs.get('volumes', {});
  const vol = Math.round((volumes[member.id] ?? 1) * 100);
  const volLabel = h('span', {}, `${vol}%`);
  const statsEl = h('dl', { class: 'stats-grid' });
  const content = h(
    'div',
    {},
    h(
      'div',
      { class: 'row', style: { alignItems: 'center', marginBottom: '12px' } },
      memberAvatar(member.id, member.info.name, 'lg'),
      h('div', {}, h('h3', {}, member.info.name), h('div', { class: 'muted small mono' }, `ID ${member.id}`)),
    ),
    h(
      'div',
      { class: 'setting' },
      h('div', { class: 'label' }, 'User volume', volLabel),
      h('input', {
        type: 'range',
        min: 0,
        max: 100,
        value: vol,
        oninput: (e) => {
          const v = Number(e.target.value) / 100;
          volLabel.textContent = `${e.target.value}%`;
          ov.setUserVolume(member.id, v);
          media.setVolume(member.id, v);
          const all = prefs.get('volumes', {});
          all[member.id] = v;
          prefs.set('volumes', all);
        },
      }),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: ov.localMutes.has(member.id),
        onchange: (e) => {
          ov.setUserLocalMute(member.id, e.target.checked);
          media.setLocalMute(member.id, e.target.checked);
          prefs.set('localMutes', [...ov.localMutes]);
        },
      }),
      h('div', {}, 'Mute for me'),
    ),
    h('div', { class: 'label muted small', style: { marginTop: '8px', fontWeight: 700 } }, 'CONNECTION'),
    statsEl,
  );
  const fmt = (v, unit, d = 0) => (v == null || Number.isNaN(v) ? '—' : `${v.toFixed(d)} ${unit}`);
  const refresh = async () => {
    const peer = ov.peers.get(member.id);
    const m = ov.roster().find((x) => x.id === member.id) || member;
    const r = ov.audioRoutes.get(member.id);
    const audioRoute = !r ? '—' : r.mode === 'direct' ? 'direct (WebRTC)' : r.mode === 'relay' ? (r.path.length > 1 ? 'relayed, E2E encrypted' : 'ultra pipeline') : 'none';
    const rows = [
      ['Route', routeLabel(m)],
      ['My audio to them', audioRoute],
    ];
    const s = peer && (await peer.getStats().catch(() => null));
    if (s) {
      rows.push(
        ['Network path', s.path || '—'],
        ['Round trip', fmt(s.rttMs, 'ms')],
        ['Receiving', fmt(s.inKbps, 'kbps')],
        ['Sending', fmt(s.outKbps, 'kbps')],
        ['Packet loss', fmt(s.lossPct, '%', 1)],
        ['Jitter buffer', fmt(s.bufferMs, 'ms')],
        ['Codec in', s.codec || '—'],
        ['Encoder', s.sendCodec || '—'],
      );
    }
    statsEl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { title: v }, v)]));
  };
  refresh();
  const timer = setInterval(refresh, 1000);
  popover(anchor, content, () => clearInterval(timer));
}

async function openRoomMenu() {
  if (!current) return;
  const room = current;
  const nameInput = h('input', { value: room.name, maxlength: 40 });
  const storage = h('div');
  const renderStorage = async () => {
    const list = await window.voice.files.list(room.id);
    const names = new Map();
    for (const c of room.channels) for (const m of await store.getMessages(room.id, c.id, 2000)) if (m.file) names.set(m.file.id, m.file.name);
    storage.replaceChildren(
      h('div', { class: 'hint' }, `${list.length} file(s), ${formatBytes(list.reduce((n, f) => n + f.size, 0))} stored on this PC`),
      ...list.map((f) =>
        h(
          'div',
          { class: 'storage-row' },
          h('span', { class: 'grow' }, names.get(f.fileId) || f.fileId),
          h('span', { class: 'muted' }, formatBytes(f.size)),
          h(
            'button',
            {
              class: 'icon-btn',
              title: 'Delete from this PC',
              onclick: async () => {
                await room.files.deleteLocal(f.fileId);
                renderStorage();
                updateFileCards(f.fileId);
              },
            },
            icon('trash', 16),
          ),
        ),
      ),
    );
  };
  renderStorage();
  const body = h(
    'div',
    {},
    h(
      'div',
      { class: 'setting' },
      h('div', { class: 'label' }, 'Invite code'),
      h('div', { class: 'copy-row' }, h('span', { class: 'invite-code' }, room.invite), h('button', { class: 'icon-btn', onclick: () => copy(room.invite) }, icon('copy', 16))),
    ),
    h(
      'div',
      { class: 'setting' },
      h('div', { class: 'label' }, 'Room name'),
      h(
        'div',
        { class: 'row' },
        nameInput,
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              const v = nameInput.value.trim();
              if (v && v !== room.name) room.applyOp({ kind: 'name', value: v });
            },
          },
          'Rename',
        ),
      ),
    ),
    h('div', { class: 'setting' }, h('div', { class: 'label' }, 'Files on this PC'), storage),
  );
  const leaveBtn = h('button', { class: 'btn danger' }, 'Leave room');
  const m = modal({ title: room.name, small: true, body, footer: [leaveBtn] });
  leaveBtn.onclick = async () => {
    const ok = await confirmModal('Leave room', 'Your copy of the chat history and files is deleted from this PC. You can rejoin with the invite code.', 'Leave', true);
    if (!ok) return;
    m.close();
    leaveRoom(room);
  };
}

$('btn-leave-voice').append(icon('hangup'));
$('btn-leave-voice').onclick = () => leaveVoice();
$('btn-mute').onclick = () => setMuted(!state.muted);
$('btn-deafen').onclick = () => setDeafened(!state.deafened);
$('btn-settings').append(icon('settings'));
$('btn-settings').onclick = () => openSettings(appCtx);
$('room-header').onclick = openRoomMenu;
$('btn-invite').append(icon('userPlus'));
$('btn-invite').onclick = () => current && showInvite(current.invite);
$('btn-toggle-members').append(icon('users'));
$('btn-toggle-members').onclick = () => {
  state.membersVisible = !state.membersVisible;
  prefs.set('membersVisible', state.membersVisible);
  $('main-view').classList.toggle('no-members', !state.membersVisible);
};
window.addEventListener('resize', debounce(closePopover, 100));
window.voice.rendezvous.onStatus((s) => {
  const before = state.rvStatus.relays.filter((r) => r.open).length;
  state.rvStatus = s;
  // A relay (re)connected: announce ourselves again so we're found quickly.
  if (s.relays.filter((r) => r.open).length > before) for (const r of rooms.values()) r.overlay._hello();
  renderHeader();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  state.appInfo = await window.voice.info();
  const arg = (k) => {
    const a = state.appInfo.args.find((x) => x === `--voice-${k}` || x.startsWith(`--voice-${k}=`));
    return a === undefined ? undefined : a.includes('=') ? a.split('=').slice(1).join('=') : true;
  };
  // Automation / testing overrides.
  if (arg('relays') !== undefined) settings.relays = String(arg('relays')).split(',').filter(Boolean);
  if (arg('no-lan')) settings.lan = false;
  if (arg('name')) state.name = String(arg('name'));
  await window.voice.rendezvous.configure({ relays: settings.relays, lan: settings.lan });
  state.rvStatus = await window.voice.rendezvous.status();

  sfx.enabled = settings.sounds;
  sfx.setSink(settings.outputDeviceId);
  audio.setMuted(state.muted);
  audio.setDeafened(state.deafened);
  await bindPtt();
  if (settings.notifications && Notification.permission === 'default') Notification.requestPermission();

  for (const record of await store.listRooms()) {
    try {
      await startRoom(record);
    } catch (err) {
      console.warn('could not start room', err);
    }
  }
  const last = rooms.get(prefs.get('lastRoom', '')) || rooms.values().next().value;
  if (last) selectRoom(last);
  else showWelcome();

  try {
    if (arg('create')) await createRoom(String(arg('create')));
    if (arg('join')) await joinRoom(String(arg('join')));
  } catch (err) {
    console.warn('auto-join failed', err);
  }
}

boot();

// For debugging and automated tests.
window.__voice = {
  settings,
  audio,
  media,
  rooms,
  get current() {
    return current;
  },
  get voiceRoom() {
    return voiceRoom;
  },
  createRoom,
  joinRoom,
  joinVoice,
  leaveVoice,
  shareFiles,
  selectRoom,
};
