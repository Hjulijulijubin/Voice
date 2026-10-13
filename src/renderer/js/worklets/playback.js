/**
 * Playback worklet: adaptive jitter buffer + mixer for audio that arrives
 * through the custom pipeline (relayed or ultra-low-latency mode).
 *
 * Each source has a ring buffer of decoded stereo PCM. Playback starts once
 * the buffer holds `target` ms (set by the media worker from measured
 * network jitter). If the buffer grows well past the target (clock drift,
 * bursts), the excess is skipped so latency never creeps up. Underruns fade
 * out instead of clicking.
 */
const CAPACITY = 48000; // 1 s of stereo frames
const FADE = 32;

class Source {
  constructor() {
    this.ring = new Float32Array(CAPACITY * 2);
    this.read = 0;
    this.size = 0; // frames
    this.target = 960; // frames (20 ms)
    this.playing = false;
    this.gain = 1;
    this.idle = 0;
  }

  push(pcm) {
    const frames = pcm.length / 2;
    if (frames > CAPACITY) return;
    if (this.size + frames > CAPACITY) this.drop(this.size + frames - CAPACITY);
    let w = ((this.read + this.size) % CAPACITY) * 2;
    for (let i = 0; i < pcm.length; i++) {
      this.ring[w++] = pcm[i];
      if (w === this.ring.length) w = 0;
    }
    this.size += frames;
    this.idle = 0;
  }

  drop(frames) {
    const n = Math.min(frames, this.size);
    this.read = (this.read + n) % CAPACITY;
    this.size -= n;
  }
}

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sources = new Map();
    this.muted = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.port) d.port.onmessage = (ev) => this.onPcm(ev.data);
      if (typeof d.muted === 'boolean') this.muted = d.muted;
      if (d.gain) this.source(d.gain.src).gain = d.gain.value;
    };
  }

  source(src) {
    let s = this.sources.get(src);
    if (!s) {
      s = new Source();
      this.sources.set(src, s);
    }
    return s;
  }

  onPcm({ src, pcm, target }) {
    const s = this.source(src);
    if (target) s.target = Math.round(target * 48);
    s.push(pcm);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;
    for (const [src, s] of this.sources) {
      if (!s.playing) {
        if (s.size >= s.target) s.playing = true;
        else {
          if (++s.idle > 3000) this.sources.delete(src); // ~8 s without audio
          continue;
        }
      }
      // Keep latency bounded: skip what exceeds target + 30 ms.
      const excess = s.size - s.target - 1440;
      if (excess > 0) s.drop(excess);
      const take = Math.min(n, s.size);
      const g = this.muted ? 0 : s.gain;
      let r = s.read * 2;
      for (let i = 0; i < take; i++) {
        let fade = 1;
        if (take < n && i >= take - FADE) fade = (take - i) / FADE; // underrun coming: fade out
        const lv = s.ring[r] * g * fade;
        const rv = s.ring[r + 1] * g * fade;
        L[i] += lv;
        R[i] += rv;
        r += 2;
        if (r === s.ring.length) r = 0;
      }
      s.drop(take);
      if (take < n) s.playing = false; // underrun: rebuffer to target
    }
    return true;
  }
}

registerProcessor('voice-playback', PlaybackProcessor);
