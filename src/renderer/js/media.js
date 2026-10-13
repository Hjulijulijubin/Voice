/**
 * Controller for the custom audio pipeline (main thread side).
 *
 * Only exists while needed: the worker and the playback context are created
 * when the first relayed route appears or the first relayed packet arrives,
 * and torn down again after 15 s without custom audio.
 */
export class MediaEngine {
  constructor(audio, settings) {
    this.audio = audio;
    this.settings = settings;
    this.worker = null;
    this.playCtx = null;
    this.playNode = null;
    this.overlay = null;
    this.selfId = null;
    this.key = null;
    this.sending = false;
    this.lastActivity = 0;
    this.lastPacket = new Map(); // src -> time
    this._idleTimer = null;
    this._starting = null;
    this.deafened = false;
    this.volumes = new Map();
    this.localMutes = new Set();
    this.packetsIn = 0;
    this.counters = null;
  }

  /** Bind to the room whose voice channel we are in. */
  setRoom(overlay, mediaKeyRaw, selfId) {
    this.overlay = overlay;
    this.selfId = selfId;
    this.key = mediaKeyRaw;
    if (this.worker) this._sendKey();
  }

  _sendKey() {
    if (!this.key) return;
    const src = new Uint8Array(8);
    for (let i = 0; i < 8; i++) src[i] = parseInt(this.selfId.substr(i * 2, 2), 16);
    this.worker.postMessage({ cmd: 'key', raw: this.key, src });
  }

  async _ensure() {
    if (this.worker) return;
    if (this._starting) return this._starting;
    this._starting = (async () => {
      const worker = new Worker(new URL('./media-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        if (e.data.out) {
          this.lastActivity = performance.now();
          this.overlay?.sendAudio(e.data.out);
        } else if (e.data.counters) this.counters = { ...e.data.counters, packetsIn: this.packetsIn };
        else if (e.data.error) console.warn(e.data.error);
      };
      this.playCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      if (this.settings.outputDeviceId && this.playCtx.setSinkId) this.playCtx.setSinkId(this.settings.outputDeviceId).catch(() => {});
      await this.playCtx.audioWorklet.addModule(new URL('./worklets/playback.js', import.meta.url));
      this.playNode = new AudioWorkletNode(this.playCtx, 'voice-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.playNode.connect(this.playCtx.destination);
      const play = new MessageChannel();
      this.playNode.port.postMessage({ port: play.port1, muted: this.deafened }, [play.port1]);
      worker.postMessage({ cmd: 'init', playPort: play.port2 }, [play.port2]);
      this.worker = worker;
      this._sendKey();
      this._sendConfig();
      for (const [src, v] of this.volumes) this.playNode.port.postMessage({ gain: { src, value: this._gain(src, v) } });
      this._idleTimer = setInterval(() => this._checkIdle(), 5000);
    })();
    try {
      await this._starting;
    } finally {
      this._starting = null;
    }
  }

  _sendConfig() {
    const q = this.settings.quality;
    this.worker?.postMessage({
      cmd: 'config',
      config: { bitrate: q.bitrate, channels: q.stereo ? 2 : 1, frameMs: this.frameMs(), fec: q.fec, dtx: q.dtx, cbr: q.cbr, complexity: this.settings.opusComplexity ?? 10 },
      jitterTargetMs: this.settings.jitterTargetMs,
    });
  }

  /** Ultra mode may use 5 ms frames (WebCodecs supports 2.5–60 ms). */
  frameMs() {
    return this.settings.audioMode === 'ultra' ? this.settings.ultraFrameMs || 5 : this.settings.quality.frameMs;
  }

  applySettings() {
    this._sendConfig();
    if (this.sending) this._connectCapture(true);
  }

  /** Called when the number of listeners on custom routes changes. */
  async setSending(on) {
    on = on && this.audio.running;
    if (on === this.sending) return;
    this.sending = on;
    if (on) {
      await this._ensure();
      this._connectCapture(true);
      this.worker.postMessage({ cmd: 'send', on: true });
      this.lastActivity = performance.now();
    } else {
      this.audio.setPcm(null, { on: false });
      this.worker?.postMessage({ cmd: 'send', on: false });
    }
  }

  _connectCapture(on) {
    const ch = new MessageChannel();
    this.worker.postMessage({ cmd: 'init', pcmPort: ch.port2 }, [ch.port2]);
    this.audio.setPcm(ch.port1, { on, frameMs: this.frameMs(), channels: this.settings.quality.stereo ? 2 : 1 });
  }

  /** The microphone was (re)started: reconnect the PCM tap if we're sending. */
  onMicRestart() {
    if (this.sending && this.worker) this._connectCapture(true);
  }

  async onPacket(payload) {
    if (payload.length < 8) return;
    let src = '';
    for (let i = 0; i < 8; i++) src += payload[i].toString(16).padStart(2, '0');
    this.lastPacket.set(src, performance.now());
    this.packetsIn++;
    this.lastActivity = performance.now();
    if (!this.worker) await this._ensure();
    const copy = payload.slice();
    this.worker.postMessage({ cmd: 'packet', data: copy.buffer }, [copy.buffer]);
  }

  isSpeaking(id) {
    const t = this.lastPacket.get(id);
    return t !== undefined && performance.now() - t < 250;
  }

  _gain(src, v) {
    return this.localMutes.has(src) ? 0 : (v ?? 1);
  }

  setVolume(src, v) {
    this.volumes.set(src, v);
    this.playNode?.port.postMessage({ gain: { src, value: this._gain(src, v) } });
  }

  setLocalMute(src, muted) {
    if (muted) this.localMutes.add(src);
    else this.localMutes.delete(src);
    this.playNode?.port.postMessage({ gain: { src, value: this._gain(src, this.volumes.get(src)) } });
  }

  setDeafened(v) {
    this.deafened = v;
    this.playNode?.port.postMessage({ muted: v });
  }

  setOutputDevice(id) {
    if (this.playCtx?.setSinkId) this.playCtx.setSinkId(id || '').catch(() => {});
  }

  _checkIdle() {
    if (this.sending || performance.now() - this.lastActivity < 15000) return;
    this.shutdown();
  }

  shutdown() {
    clearInterval(this._idleTimer);
    this.worker?.terminate();
    this.worker = null;
    this.playCtx?.close().catch(() => {});
    this.playCtx = null;
    this.playNode = null;
    this.sending = false;
    this.lastPacket.clear();
  }
}
