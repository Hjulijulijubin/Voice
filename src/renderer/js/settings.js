import { h, prefs } from './util.js';
import { modal, toast } from './ui.js';
import { DEFAULT_QUALITY, OPUS_MAX_BITRATE } from './opus.js';

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://relay.snort.social'];

export const DEFAULT_SETTINGS = {
  inputDeviceId: '',
  outputDeviceId: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
  inputMode: 'vad', // 'vad' | 'ptt' | 'open'
  vadThreshold: -50, // dBFS
  vadHoldMs: 300,
  pttBinding: { type: 'key', code: 'KeyV' },
  pttReleaseMs: 120,
  quality: { ...DEFAULT_QUALITY },
  jitterTargetMs: 0,
  audioMode: 'auto', // 'auto' (WebRTC direct, custom when relayed) | 'ultra' (custom pipeline everywhere)
  ultraFrameMs: 5,
  allowRelay: true,
  relays: [...DEFAULT_RELAYS],
  lan: true,
  iceServers: '',
  autoDownloadMB: 50, // 0 = never, -1 = always
  sounds: true,
  notifications: true,
};

export function loadSettings() {
  const saved = prefs.get('settings', {});
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    quality: { ...DEFAULT_QUALITY, ...(saved.quality || {}) },
  };
}

export function saveSettings(settings) {
  prefs.set('settings', settings);
}

/**
 * Parse the user's extra ICE servers. One per line:
 *   stun:stun.example.com:3478
 *   turn:turn.example.com:3478|username|password
 */
export function parseIceServers(text) {
  const out = [];
  for (const line of (text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [urls, username, credential] = trimmed.split('|').map((s) => s.trim());
    if (!/^(stun|stuns|turn|turns):/i.test(urls)) continue;
    out.push(username ? { urls, username, credential } : { urls });
  }
  return out;
}

export function describeBinding(b) {
  if (!b) return 'Not set';
  if (b.type === 'mouse') return ['Left click', 'Middle click', 'Right click', 'Mouse 4', 'Mouse 5'][b.button] || `Mouse ${b.button + 1}`;
  const code = b.code || '';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.replace(/Left$/, ' (L)').replace(/Right$/, ' (R)');
}

/** Presets for typical setups. */
const PRESETS = {
  voice: {
    label: 'Voice chat',
    hint: 'Echo cancellation + noise suppression. Safe with speakers.',
    apply: (s) => {
      Object.assign(s, { echoCancellation: true, noiseSuppression: true, autoGainControl: false });
      Object.assign(s.quality, { bitrate: 128000, stereo: false, frameMs: 10, fec: true, dtx: false, cbr: false });
    },
  },
  hifi: {
    label: 'Hi-Fi / Music',
    hint: 'No processing, stereo, 510 kbps. Use headphones!',
    apply: (s) => {
      Object.assign(s, { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
      Object.assign(s.quality, { bitrate: OPUS_MAX_BITRATE, stereo: true, frameMs: 10, fec: true, dtx: false, cbr: false });
    },
  },
  lowbw: {
    label: 'Bad connection',
    hint: '64 kbps mono, 20 ms frames, FEC. More robust on weak links.',
    apply: (s) => {
      Object.assign(s, { echoCancellation: true, noiseSuppression: true, autoGainControl: false });
      Object.assign(s.quality, { bitrate: 64000, stereo: false, frameMs: 20, fec: true, dtx: false, cbr: false });
    },
  },
};

/**
 * Settings dialog.
 * @param {object} app  callbacks/state from app.js
 * @param {string} [initialTab]
 */
export function openSettings(app, initialTab = 'audio') {
  const s = app.settings;
  const cleanups = [];
  const tabNames = { audio: 'Voice & Audio', quality: 'Opus Quality', network: 'Network & Files', profile: 'Profile', about: 'About' };
  const tabsEl = h('div', { class: 'tabs' });
  const body = h('div');
  let current = initialTab;

  const save = () => saveSettings(s);

  const renderTab = async (name) => {
    current = name;
    while (cleanups.length) cleanups.pop()();
    tabsEl.replaceChildren(
      ...Object.entries(tabNames).map(([key, label]) =>
        h('button', { class: `tab${key === name ? ' active' : ''}`, onclick: () => renderTab(key) }, label),
      ),
    );
    body.replaceChildren();
    if (name === 'audio') await audioTab();
    if (name === 'quality') qualityTab();
    if (name === 'network') await networkTab();
    if (name === 'profile') profileTab();
    if (name === 'about') await aboutTab();
  };

  // ------------------------------------------------------------- audio tab
  async function audioTab() {
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.some((d) => d.kind === 'audioinput' && !d.label)) {
      // Labels are hidden until mic permission is granted once.
      try {
        await app.requestMediaAccess();
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch {
        /* user denied; show unnamed devices */
      }
    }
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const outputs = devices.filter((d) => d.kind === 'audiooutput');

    const deviceSelect = (list, value, onChange) =>
      h(
        'select',
        { onchange: (e) => onChange(e.target.value) },
        h('option', { value: '' }, 'System default'),
        ...list
          .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
          .map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === value }, d.label || `Device ${i + 1}`)),
      );

    const inputSel = deviceSelect(inputs, s.inputDeviceId, (v) => {
      s.inputDeviceId = v;
      save();
      app.restartMic();
    });
    const outputSel = deviceSelect(outputs, s.outputDeviceId, (v) => {
      s.outputDeviceId = v;
      save();
      app.applyOutput();
    });

    // Live meter with threshold marker.
    const fill = h('div', { class: 'fill' });
    const marker = h('div', { class: 'threshold' });
    const meter = h('div', { class: 'meter' }, fill, marker);
    const dbToPct = (db) => Math.max(0, Math.min(100, ((db + 80) / 80) * 100));
    const updateMarker = () => {
      marker.style.left = `${dbToPct(s.vadThreshold)}%`;
      marker.style.display = s.inputMode === 'vad' ? '' : 'none';
    };
    updateMarker();
    // Level messages only flow while a meter is visible (saves CPU otherwise).
    app.audio.meter(true);
    const offLevel = app.audio.on('level', (lvl) => {
      fill.style.width = `${dbToPct(lvl)}%`;
      fill.classList.toggle('below', s.inputMode === 'vad' && lvl < s.vadThreshold);
    });
    cleanups.push(() => {
      offLevel();
      app.audio.meter(false);
    });

    const vadValue = h('span', {}, `${s.vadThreshold} dB`);
    const vadSlider = h('input', {
      type: 'range',
      min: -80,
      max: 0,
      step: 1,
      value: s.vadThreshold,
      oninput: (e) => {
        s.vadThreshold = Number(e.target.value);
        vadValue.textContent = `${s.vadThreshold} dB`;
        updateMarker();
        save();
        app.audio.syncGate();
      },
    });

    const testBtn = h('button', { class: 'btn small' });
    const updateTestBtn = () => {
      testBtn.textContent = app.audio.loopbackActive ? 'Stop hearing myself' : 'Let me hear myself';
    };
    updateTestBtn();
    testBtn.onclick = async () => {
      if (app.audio.loopbackActive) {
        app.audio.stopLoopback();
        app.releaseMicIfIdle();
      } else {
        try {
          await app.ensureMic();
          app.audio.startLoopback();
        } catch (err) {
          toast(`Microphone error: ${err.message}`, 'error');
        }
      }
      updateTestBtn();
    };
    cleanups.push(() => {
      if (app.audio.loopbackActive) {
        app.audio.stopLoopback();
      }
      app.releaseMicIfIdle();
    });
    // Make sure the meter has something to show.
    app.ensureMic().catch(() => {});

    const modeRadio = (value, label) =>
      h(
        'label',
        {},
        h('input', {
          type: 'radio',
          name: 'inputMode',
          value,
          checked: s.inputMode === value,
          onchange: () => {
            s.inputMode = value;
            save();
            app.audio.syncGate();
            app.renderSelf();
            updateMarker();
            pttBox.classList.toggle('hidden', value !== 'ptt');
            vadBox.classList.toggle('hidden', value !== 'vad');
          },
        }),
        label,
      );

    const keyBtn = h('button', { class: 'btn keybind' }, describeBinding(s.pttBinding));
    keyBtn.onclick = () => {
      keyBtn.classList.add('listening');
      keyBtn.textContent = 'Press a key or mouse button…';
      const finish = (binding) => {
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('mousedown', onMouse, true);
        keyBtn.classList.remove('listening');
        if (binding) {
          s.pttBinding = binding;
          save();
          app.bindPtt();
        }
        keyBtn.textContent = describeBinding(s.pttBinding);
      };
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        finish(e.code === 'Escape' ? null : { type: 'key', code: e.code });
      };
      const onMouse = (e) => {
        if (e.button === 0 && e.target === keyBtn) return; // the click that started listening
        if (e.button === 0) return finish(null);
        e.preventDefault();
        e.stopPropagation();
        finish({ type: 'mouse', button: e.button });
      };
      setTimeout(() => {
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('mousedown', onMouse, true);
      }, 0);
      cleanups.push(() => finish(null));
    };

    const releaseValue = h('span', {}, `${s.pttReleaseMs} ms`);
    const pttBox = h(
      'div',
      { class: `setting${s.inputMode === 'ptt' ? '' : ' hidden'}` },
      h('div', { class: 'label' }, 'Push-to-talk key'),
      h('div', { class: 'row' }, keyBtn),
      h(
        'div',
        { class: 'hint' },
        app.globalPtt
          ? 'Works globally, even while a game is focused.' + (app.platform === 'darwin' ? ' macOS: allow Voice under Privacy & Security → Accessibility.' : '')
          : 'Global hotkeys unavailable on this system: push-to-talk works while the Voice window is focused.',
      ),
      h('div', { class: 'label', style: { marginTop: '12px' } }, 'Release delay', releaseValue),
      h('input', {
        type: 'range',
        min: 0,
        max: 500,
        step: 10,
        value: s.pttReleaseMs,
        oninput: (e) => {
          s.pttReleaseMs = Number(e.target.value);
          releaseValue.textContent = `${s.pttReleaseMs} ms`;
          save();
        },
      }),
    );

    const vadBox = h(
      'div',
      { class: `setting${s.inputMode === 'vad' ? '' : ' hidden'}` },
      h('div', { class: 'label' }, 'Voice activation threshold', vadValue),
      vadSlider,
      h('div', { class: 'hint' }, 'Speak normally: the bar should pass the white marker. Background noise should stay below it.'),
    );

    const processingCheck = (key, label, hint) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: s[key],
          onchange: (e) => {
            s[key] = e.target.checked;
            save();
            app.restartMic();
          },
        }),
        h('div', {}, h('div', {}, label), h('div', { class: 'hint' }, hint)),
      );

    body.append(
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'setting grow' }, h('div', { class: 'label' }, 'Input device'), inputSel),
        h('div', { class: 'setting grow' }, h('div', { class: 'label' }, 'Output device'), outputSel),
      ),
      h('div', { class: 'setting' }, h('div', { class: 'label' }, 'Mic level'), meter, h('div', { class: 'row' }, testBtn)),
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'label' }, 'Input mode'),
        h('div', { class: 'radio-row' }, modeRadio('vad', 'Voice activity'), modeRadio('ptt', 'Push to talk'), modeRadio('open', 'Always on')),
      ),
      vadBox,
      pttBox,
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'label' }, 'Audio processing'),
        processingCheck('echoCancellation', 'Echo cancellation', 'Needed with speakers. Forces mono capture — turn off with headphones for stereo.'),
        processingCheck('noiseSuppression', 'Noise suppression', 'Removes fans and keyboard noise. Turn off for music/instruments.'),
        processingCheck('autoGainControl', 'Automatic gain control', 'Evens out your volume. Can pump on music.'),
      ),
    );
  }

  // ----------------------------------------------------------- quality tab
  function qualityTab() {
    const q = s.quality;
    const changed = () => {
      save();
      app.applyQuality();
      latency.textContent = latencyText();
    };
    const latencyText = () =>
      `Estimated mouth-to-ear delay without network: ~${q.frameMs + 5 + Math.max(s.jitterTargetMs, 10)}–${q.frameMs * 2 + 15 + s.jitterTargetMs} ms (frame ${q.frameMs} ms + encode/decode + jitter buffer) plus one-way network time.`;
    const latency = h('div', { class: 'callout' }, latencyText());

    const bitrateValue = h('span', {}, `${Math.round(q.bitrate / 1000)} kbps`);
    const bitrate = h('input', {
      type: 'range',
      min: 32,
      max: 510,
      step: 2,
      value: Math.round(q.bitrate / 1000),
      oninput: (e) => {
        q.bitrate = Number(e.target.value) * 1000;
        bitrateValue.textContent = `${e.target.value} kbps`;
      },
      onchange: changed,
    });

    const frameSel = h(
      'select',
      {
        onchange: (e) => {
          q.frameMs = Number(e.target.value);
          changed();
        },
      },
      ...[
        [10, '10 ms — lowest delay (default)'],
        [20, '20 ms — standard WebRTC'],
        [40, '40 ms — fewer packets'],
        [60, '60 ms — most robust, highest delay'],
      ].map(([v, label]) => h('option', { value: v, selected: q.frameMs === v }, label)),
    );

    const toggle = (key, label, hint) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: q[key],
          onchange: (e) => {
            q[key] = e.target.checked;
            changed();
          },
        }),
        h('div', {}, h('div', {}, label), h('div', { class: 'hint' }, hint)),
      );

    const jbValue = h('span', {}, s.jitterTargetMs ? `${s.jitterTargetMs} ms` : 'Lowest');
    const jb = h('input', {
      type: 'range',
      min: 0,
      max: 200,
      step: 5,
      value: s.jitterTargetMs,
      oninput: (e) => {
        s.jitterTargetMs = Number(e.target.value);
        jbValue.textContent = s.jitterTargetMs ? `${s.jitterTargetMs} ms` : 'Lowest';
      },
      onchange: () => {
        save();
        app.applyJitterTarget();
        latency.textContent = latencyText();
      },
    });

    const presetRow = h(
      'div',
      { class: 'radio-row' },
      ...Object.values(PRESETS).map((p) =>
        h(
          'button',
          {
            class: 'btn small',
            title: p.hint,
            onclick: () => {
              p.apply(s);
              save();
              app.restartMic();
              app.applyQuality();
              renderTab('quality');
              toast(`Preset "${p.label}" applied`);
            },
          },
          p.label,
        ),
      ),
    );

    body.append(
      h(
        'div',
        { class: 'callout' },
        'These settings control the audio ',
        h('strong', {}, 'you send'),
        '. Everyone always advertises that they can receive full-band stereo at 510 kbps, so each person picks their own quality. Changes apply live.',
      ),
      h('div', { class: 'setting' }, h('div', { class: 'label' }, 'Presets'), presetRow),
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'label' }, 'Opus bitrate', bitrateValue),
        bitrate,
        h('div', { class: 'hint' }, '64 kbps is already transparent for speech; 128–256 kbps for music; 510 kbps is the Opus maximum.'),
      ),
      h('div', { class: 'setting' }, h('div', { class: 'label' }, 'Frame size'), frameSel),
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'label' }, 'Encoder'),
        toggle('stereo', 'Stereo', 'Sends two channels. Requires echo cancellation to be off (it forces mono).'),
        toggle('fec', 'Forward error correction', 'Opus in-band FEC hides lost packets. Recommended.'),
        toggle('dtx', 'Discontinuous transmission (DTX)', 'Saves bandwidth during silence, may cut quiet sounds. Off for best quality.'),
        toggle('cbr', 'Constant bitrate', 'Fixed packet sizes. Usually not needed.'),
      ),
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'label' }, 'Jitter buffer target (incoming audio)', jbValue),
        jb,
        h('div', { class: 'hint' }, 'Lowest = the receiver keeps as little audio buffered as the network allows. Raise it if voices sound choppy on Wi-Fi.'),
      ),
      latency,
    );
  }

  // ----------------------------------------------------------- network tab
  async function networkTab() {
    const radio = (name, value, label, hint, current, onPick) =>
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'radio', name, value, checked: current === value, onchange: () => onPick(value) }),
        h('div', {}, h('div', {}, label), h('div', { class: 'hint' }, hint)),
      );
    const check = (key, label, hint, after) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: s[key],
          onchange: (e) => {
            s[key] = e.target.checked;
            save();
            after?.();
          },
        }),
        h('div', {}, h('div', {}, label), hint ? h('div', { class: 'hint' }, hint) : null),
      );

    const relays = h('textarea', { rows: 4, class: 'mono', style: { width: '100%' } });
    relays.value = s.relays.join('\n');
    relays.onchange = () => {
      s.relays = relays.value.split('\n').map((l) => l.trim()).filter((l) => /^wss?:\/\//i.test(l));
      save();
      app.applyNetwork();
      toast('Rendezvous relays updated');
    };
    const ice = h('textarea', { rows: 3, class: 'mono', placeholder: 'turn:turn.example.com:3478|username|password', style: { width: '100%' } });
    ice.value = s.iceServers;
    ice.onchange = () => {
      s.iceServers = ice.value;
      save();
      toast('Saved. Applies to new connections.');
    };
    const status = await window.voice.rendezvous.status();
    const openRelays = status.relays.filter((r) => r.open).length;

    const auto = h(
      'select',
      {
        onchange: (e) => {
          s.autoDownloadMB = Number(e.target.value);
          save();
        },
      },
      ...[
        [0, 'Never (download on click)'],
        [10, 'Files up to 10 MB'],
        [50, 'Files up to 50 MB'],
        [250, 'Files up to 250 MB'],
        [1024, 'Files up to 1 GB'],
        [-1, 'Everything'],
      ].map(([v, l]) => h('option', { value: v, selected: s.autoDownloadMB === v }, l)),
    );

    body.append(
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'label' }, 'Audio transport'),
        radio('audioMode', 'auto', 'Automatic (recommended)', 'Direct WebRTC audio with adaptive jitter buffer; switches to routing through other members when that is faster or a direct connection is impossible.', s.audioMode, (v) => {
          s.audioMode = v;
          save();
          app.applyMode();
        }),
        radio('audioMode', 'ultra', 'Ultra-low latency', 'Custom pipeline for everyone: 2.5–10 ms Opus frames, minimal buffering, always on the fastest route. Best on good networks.', s.audioMode, (v) => {
          s.audioMode = v;
          save();
          app.applyMode();
        }),
        h(
          'div',
          { class: 'row', style: { alignItems: 'center', marginTop: '6px' } },
          h('span', { class: 'muted small' }, 'Ultra frame size'),
          h(
            'select',
            {
              onchange: (e) => {
                s.ultraFrameMs = Number(e.target.value);
                save();
                app.applyMode();
              },
            },
            ...[2.5, 5, 10].map((v) => h('option', { value: v, selected: s.ultraFrameMs === v }, `${v} ms`)),
          ),
        ),
      ),
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'label' }, 'Smart routing'),
        check('allowRelay', 'Let my connection relay audio/data for other members', 'Helps friends who can\'t reach each other directly or have a slow path. Everything relayed stays end-to-end encrypted.', () => app.applyNetwork()),
      ),
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'label' }, 'Finding each other', h('span', {}, `${openRelays}/${status.relays.length} relays · LAN ${status.lan ? 'on' : 'off'}`)),
        check('lan', 'Discover members on the local network', 'Works without internet.', () => app.applyNetwork()),
        h('div', { class: 'hint', style: { margin: '8px 0 4px' } }, 'Rendezvous relays (Nostr, one per line). They only ever see an anonymous room hash and encrypted handshakes; you can self-host one (see README).'),
        relays,
      ),
      h('div', { class: 'setting' }, h('div', { class: 'label' }, 'Extra STUN / TURN servers'), ice, h('div', { class: 'hint' }, 'Optional, one per line. TURN format: url|username|password')),
      h('div', { class: 'setting' }, h('div', { class: 'label' }, 'Automatically store shared files on this PC'), auto),
    );
  }

  // ----------------------------------------------------------- profile tab
  function profileTab() {
    const name = h('input', { value: app.name, maxlength: 32 });
    const check = (key, label) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: s[key],
          onchange: (e) => {
            s[key] = e.target.checked;
            save();
            app.applyMisc();
          },
        }),
        h('div', {}, label),
      );
    body.append(
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'label' }, 'Display name'),
        h(
          'div',
          { class: 'row' },
          name,
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                const v = name.value.trim();
                if (v) app.setName(v);
              },
            },
            'Save',
          ),
        ),
      ),
      h('div', { class: 'setting' }, h('div', { class: 'label' }, 'Notifications'), check('sounds', 'Play sounds (join/leave/mute/message)'), check('notifications', 'Desktop notifications for mentions')),
      h(
        'div',
        { class: 'setting' },
        h('div', { class: 'label' }, 'Performance'),
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: !app.hardwareAcceleration,
            onchange: (e) => window.voice.setHardwareAcceleration(!e.target.checked),
          }),
          h('div', {}, h('div', {}, 'Low-resource mode (disable GPU acceleration)'), h('div', { class: 'hint' }, 'Saves memory on older PCs. Restarts the app.')),
        ),
      ),
    );
  }

  // ------------------------------------------------------------- about tab
  async function aboutTab() {
    const info = await window.voice.info();
    body.append(
      h('p', {}, h('strong', {}, `Voice ${info.version}`), ` on ${info.platform}${info.profile ? ` (profile "${info.profile}")` : ''}`),
      h('p', { class: 'muted' }, 'Open source peer-to-peer voice and chat. Licensed under GPL-3.0.'),
      h(
        'dl',
        { class: 'stats-grid' },
        h('dt', {}, 'Codec'),
        h('dd', {}, 'Opus, 48 kHz'),
        h('dt', {}, 'Transport'),
        h('dd', {}, 'WebRTC (DTLS-SRTP, SCTP)'),
        h('dt', {}, 'Relayed data'),
        h('dd', {}, 'AES-256-GCM, room key'),
        h('dt', {}, 'Identity'),
        h('dd', {}, 'Ed25519, per room, no account'),
      ),
    );
  }

  const m = modal({
    title: 'Settings',
    tabs: tabsEl,
    body,
    onClose: () => {
      while (cleanups.length) cleanups.pop()();
    },
  });
  renderTab(current);
  return m;
}

