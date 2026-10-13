/**
 * Capture worklet (runs on the real-time audio thread).
 *
 * - Measures the mic level every 10 ms and runs voice activity detection.
 * - Owns the transmit gate (mute / push-to-talk / VAD / open mic) and tells
 *   the main thread when it opens or closes.
 * - When the custom pipeline is active, streams PCM frames (one Opus frame
 *   each) straight to the media worker over a MessagePort — the main thread
 *   is never in the audio path.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 'vad';
    this.threshold = -50;
    this.holdFrames = 300 * 48;
    this.muted = false;
    this.ptt = false;
    this.vadOpen = false;
    this.hold = 0;
    this.tx = false;
    this.meter = false;
    this.meterTick = 0;
    this.sumSq = 0;
    this.count = 0;
    this.pcmPort = null;
    this.pcm = false;
    this.channels = 2;
    this.frame = 480;
    this.buf = null;
    this.pos = 0;
    this.port.onmessage = (e) => this.configure(e.data);
  }

  configure(d) {
    if (d.pcmPort) this.pcmPort = d.pcmPort;
    if (d.mode) this.mode = d.mode;
    if (typeof d.threshold === 'number') this.threshold = d.threshold;
    if (typeof d.holdMs === 'number') this.holdFrames = d.holdMs * 48;
    if (typeof d.muted === 'boolean') this.muted = d.muted;
    if (typeof d.ptt === 'boolean') this.ptt = d.ptt;
    if (typeof d.meter === 'boolean') this.meter = d.meter;
    if (typeof d.pcm === 'boolean') this.pcm = d.pcm;
    if (d.frameMs) this.frame = d.frameMs * 48;
    if (d.channels) this.channels = d.channels;
    if (d.frameMs || d.channels) {
      this.buf = null;
      this.pos = 0;
    }
    this.gate();
  }

  gate() {
    const open = !this.muted && (this.mode === 'open' || (this.mode === 'ptt' && this.ptt) || (this.mode === 'vad' && this.vadOpen));
    if (open !== this.tx) {
      this.tx = open;
      this.pos = 0;
      this.port.postMessage({ tx: open });
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const l = input[0];
    const r = input[1] || l;
    const n = l.length;
    for (let i = 0; i < n; i++) {
      const s = (l[i] + r[i]) * 0.5;
      this.sumSq += s * s;
    }
    this.count += n;
    if (this.count >= 480) {
      const rms = Math.sqrt(this.sumSq / this.count);
      const db = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
      if (db >= this.threshold) this.hold = this.holdFrames;
      else this.hold -= this.count;
      const open = this.hold > 0;
      if (open !== this.vadOpen) {
        this.vadOpen = open;
        this.gate();
      }
      if (this.meter && ++this.meterTick % 5 === 0) this.port.postMessage({ level: db });
      this.sumSq = 0;
      this.count = 0;
    }

    if (this.pcm && this.tx && this.pcmPort) {
      const ch = this.channels;
      if (!this.buf) this.buf = new Float32Array(this.frame * ch);
      for (let i = 0; i < n; i++) {
        if (ch === 2) {
          this.buf[this.pos++] = l[i];
          this.buf[this.pos++] = r[i];
        } else {
          this.buf[this.pos++] = (l[i] + r[i]) * 0.5;
        }
        if (this.pos === this.buf.length) {
          this.pcmPort.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.frame * ch);
          this.pos = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('voice-capture', CaptureProcessor);
