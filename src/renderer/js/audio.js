import { Emitter } from './util.js';

/**
 * Microphone capture.
 *
 * - The raw mic track goes straight into WebRTC for direct connections
 *   (zero extra buffering).
 * - A *clone* of the track feeds the capture worklet on the audio thread,
 *   which does level metering, voice activity detection and owns the
 *   transmit gate; it also taps PCM for the custom pipeline when needed.
 *   No main-thread timers run for audio.
 */
export class AudioEngine extends Emitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.track = null;
    this.ctx = null;
    this.node = null;
    this._analysisTrack = null;
    this.muted = false;
    this.deafened = false;
    this.pttDown = false;
    this._pttTimer = null;
    this.level = -100;
    this.transmitting = false;
    this._loopback = null;
    this._meterUsers = 0;
    this._pcm = null;
  }

  constraints() {
    const s = this.settings;
    return {
      audio: {
        deviceId: s.inputDeviceId ? { exact: s.inputDeviceId } : undefined,
        echoCancellation: s.echoCancellation,
        noiseSuppression: s.noiseSuppression,
        autoGainControl: s.autoGainControl,
        channelCount: { ideal: s.quality.stereo ? 2 : 1 },
        sampleRate: { ideal: 48000 },
        sampleSize: { ideal: 16 },
        latency: { ideal: 0 },
      },
      video: false,
    };
  }

  get running() {
    return !!this.track;
  }

  async start() {
    if (this.track) return this.track;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(this.constraints());
    } catch (err) {
      if (this.settings.inputDeviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        this.settings.inputDeviceId = '';
        stream = await navigator.mediaDevices.getUserMedia(this.constraints());
      } else {
        throw err;
      }
    }
    this.track = stream.getAudioTracks()[0];
    this.track.contentHint = this.settings.echoCancellation || this.settings.noiseSuppression ? 'speech' : 'music';
    this.track.onended = () => this.emit('device-lost');
    this.track.enabled = false;
    await this._setupWorklet();
    this.emit('track', this.track);
    return this.track;
  }

  async _setupWorklet() {
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    await this.ctx.audioWorklet.addModule(new URL('./worklets/capture.js', import.meta.url));
    this._analysisTrack = this.track.clone();
    this._analysisTrack.enabled = true;
    const src = this.ctx.createMediaStreamSource(new MediaStream([this._analysisTrack]));
    this.node = new AudioWorkletNode(this.ctx, 'voice-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    this.node.port.onmessage = (e) => {
      const d = e.data;
      if (typeof d.level === 'number') {
        this.level = d.level;
        this.emit('level', d.level);
      }
      if (typeof d.tx === 'boolean') {
        if (this.track) this.track.enabled = d.tx;
        this._setTransmitting(d.tx);
      }
    };
    src.connect(this.node);
    this.syncGate();
    this.node.port.postMessage({ meter: this._meterUsers > 0 });
    if (this._pcm) this.node.port.postMessage(this._pcm);
  }

  stop() {
    this.stopLoopback();
    this._analysisTrack?.stop();
    this._analysisTrack = null;
    this.track?.stop();
    this.track = null;
    this.node = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this._setTransmitting(false);
    this.emit('track', null);
  }

  async restart() {
    if (!this.running) return;
    const loop = !!this._loopback;
    this.stop();
    await this.start();
    if (loop) this.startLoopback();
  }

  /** Push gate parameters (mode, threshold, mute, PTT) to the worklet. */
  syncGate() {
    const s = this.settings;
    this.node?.port.postMessage({ mode: s.inputMode, threshold: s.vadThreshold, holdMs: s.vadHoldMs, muted: this.muted || this.deafened, ptt: this.pttDown });
  }

  /** Level messages are only produced while someone shows a meter. */
  meter(on) {
    this._meterUsers = Math.max(0, this._meterUsers + (on ? 1 : -1));
    this.node?.port.postMessage({ meter: this._meterUsers > 0 });
  }

  /** Connect the PCM tap to the media worker (custom pipeline). */
  setPcm(port, { on, frameMs, channels }) {
    this._pcm = { pcm: on, frameMs, channels };
    if (port) {
      this._pcmPort = port;
      this.node?.port.postMessage({ pcmPort: port, ...this._pcm }, [port]);
      return;
    }
    this.node?.port.postMessage(this._pcm);
  }

  _setTransmitting(value) {
    if (value === this.transmitting) return;
    this.transmitting = value;
    this.emit('transmitting', value);
  }

  setMuted(value) {
    this.muted = value;
    this.syncGate();
  }

  setDeafened(value) {
    this.deafened = value;
    this.syncGate();
  }

  setPtt(down) {
    clearTimeout(this._pttTimer);
    if (down) {
      if (this.pttDown) return;
      this.pttDown = true;
      this.syncGate();
    } else {
      // Short release delay so the last syllable isn't cut off.
      this._pttTimer = setTimeout(() => {
        this.pttDown = false;
        this.syncGate();
      }, this.settings.pttReleaseMs);
    }
  }

  startLoopback() {
    if (!this.track || this._loopback) return;
    const el = new Audio();
    el.srcObject = new MediaStream([this._analysisTrack]);
    if (this.settings.outputDeviceId && el.setSinkId) el.setSinkId(this.settings.outputDeviceId).catch(() => {});
    el.play().catch(() => {});
    this._loopback = el;
  }

  stopLoopback() {
    if (!this._loopback) return;
    this._loopback.pause();
    this._loopback.srcObject = null;
    this._loopback = null;
  }

  get loopbackActive() {
    return !!this._loopback;
  }
}

/** Tiny synthesized UI sounds. The audio device is released when idle. */
export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.sinkId = '';
    this._idle = null;
  }

  setSink(id) {
    this.sinkId = id || '';
    if (this.ctx?.setSinkId) this.ctx.setSinkId(this.sinkId).catch(() => {});
  }

  play(kind) {
    if (!this.enabled) return;
    const tones = {
      join: [523.25, 783.99],
      leave: [783.99, 523.25],
      mute: [440, 330],
      unmute: [330, 440],
      message: [880],
      connect: [392, 523.25, 659.25],
    }[kind];
    if (!tones) return;
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      if (this.sinkId && this.ctx.setSinkId) this.ctx.setSinkId(this.sinkId).catch(() => {});
    }
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const start = ctx.currentTime + 0.01;
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      const t = start + i * 0.08;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.13);
    });
    // An open AudioContext keeps the sound card busy: suspend when quiet.
    clearTimeout(this._idle);
    this._idle = setTimeout(() => ctx.suspend().catch(() => {}), 1500);
  }
}
