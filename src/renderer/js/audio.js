import { Emitter } from './util.js';

/**
 * Microphone capture, voice activity detection and push-to-talk.
 *
 * Latency notes:
 *   - The captured track is sent to WebRTC directly. No WebAudio processing
 *     sits in the send path, so it adds zero extra buffering.
 *   - Level metering / VAD runs on a *clone* of the track, so disabling the
 *     sent track (mute, PTT released) never blinds the detector.
 *   - Gating is done with `track.enabled`, which takes effect immediately.
 */
export class AudioEngine extends Emitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.stream = null;
    this.track = null;
    this.ctx = null;
    this.analyser = null;
    this._analysisTrack = null;
    this._timer = null;
    this.muted = false;
    this.deafened = false;
    this.pttDown = false;
    this._pttReleaseTimer = null;
    this.vadOpen = false;
    this._vadHoldUntil = 0;
    this.level = -100;
    this.transmitting = false;
    this._loopback = null;
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
        // Saved device is gone: fall back to the system default.
        this.settings.inputDeviceId = '';
        stream = await navigator.mediaDevices.getUserMedia(this.constraints());
      } else {
        throw err;
      }
    }
    this.stream = stream;
    this.track = stream.getAudioTracks()[0];
    this.track.contentHint = this.settings.echoCancellation || this.settings.noiseSuppression ? 'speech' : 'music';
    this.track.onended = () => this.emit('device-lost');
    this._setupAnalysis();
    this._applyGate();
    this.emit('track', this.track);
    return this.track;
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    this.stopLoopback();
    this._analysisTrack?.stop();
    this._analysisTrack = null;
    this.track?.stop();
    this.track = null;
    this.stream = null;
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    this._setTransmitting(false);
    this.emit('track', null);
  }

  /** Re-acquire the microphone (device or processing settings changed). */
  async restart() {
    const wasRunning = this.running;
    const loop = !!this._loopback;
    if (!wasRunning) return;
    this.stop();
    await this.start();
    if (loop) this.startLoopback();
  }

  _setupAnalysis() {
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    this._analysisTrack = this.track.clone();
    this._analysisTrack.enabled = true;
    const src = this.ctx.createMediaStreamSource(new MediaStream([this._analysisTrack]));
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    const buf = new Float32Array(this.analyser.fftSize);
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      this.level = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
      const now = performance.now();
      if (this.level >= this.settings.vadThreshold) this._vadHoldUntil = now + this.settings.vadHoldMs;
      const open = now < this._vadHoldUntil;
      if (open !== this.vadOpen) {
        this.vadOpen = open;
        this._applyGate();
      }
      this.emit('level', this.level);
    }, 10);
  }

  _applyGate() {
    const s = this.settings;
    let open;
    if (this.muted || this.deafened) open = false;
    else if (s.inputMode === 'ptt') open = this.pttDown;
    else if (s.inputMode === 'vad') open = this.vadOpen;
    else open = true;
    if (this.track) this.track.enabled = open;
    this._setTransmitting(open && !!this.track);
  }

  _setTransmitting(value) {
    if (value === this.transmitting) return;
    this.transmitting = value;
    this.emit('transmitting', value);
  }

  setMuted(value) {
    this.muted = value;
    this._applyGate();
  }

  setDeafened(value) {
    this.deafened = value;
    this._applyGate();
  }

  setPtt(down) {
    clearTimeout(this._pttReleaseTimer);
    if (down) {
      this.pttDown = true;
      this._applyGate();
    } else {
      // A short release delay avoids cutting off the last syllable.
      this._pttReleaseTimer = setTimeout(() => {
        this.pttDown = false;
        this._applyGate();
      }, this.settings.pttReleaseMs);
    }
  }

  refreshGate() {
    this._applyGate();
  }

  /** Play your own microphone back to you (to judge quality and latency). */
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

/** Tiny synthesized UI sounds (no asset files needed). */
export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.sinkId = '';
  }

  _ensure() {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (this.sinkId && this.ctx.setSinkId) this.ctx.setSinkId(this.sinkId).catch(() => {});
    return this.ctx;
  }

  setSink(id) {
    this.sinkId = id;
    if (this.ctx?.setSinkId) this.ctx.setSinkId(id || '').catch(() => {});
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
    const ctx = this._ensure();
    const start = ctx.currentTime + 0.01;
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = start + i * 0.08;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.13);
    });
  }
}
