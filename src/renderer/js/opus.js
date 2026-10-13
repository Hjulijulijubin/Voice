/**
 * Opus tuning via SDP.
 *
 * WebRTC uses Opus for audio, but browsers default to conservative settings
 * (mono, ~32 kbps, 20 ms frames). The Opus encoder is configured from the
 * fmtp parameters the *remote* side advertises, so we:
 *
 *   - rewrite our LOCAL description to tell the other side "I can receive the
 *     best possible audio" (stereo, 510 kbps, full band), and
 *   - rewrite the REMOTE description before applying it so that OUR encoder
 *     uses OUR quality settings (bitrate, stereo, frame size, FEC, DTX, CBR).
 *
 * This way every user controls the quality of the audio they send.
 */

export const OPUS_MAX_BITRATE = 510000;
export const VALID_FRAME_SIZES = [10, 20, 40, 60];

/** Default send settings: low delay + high bitrate. */
export const DEFAULT_QUALITY = Object.freeze({
  bitrate: 256000, // bits/s, 6000..510000
  stereo: true,
  frameMs: 10, // Opus frame size; 10 ms is the lowest WebRTC supports
  fec: true, // in-band forward error correction (helps on lossy links)
  dtx: false, // discontinuous transmission adds artefacts on pauses
  cbr: false, // constant bitrate
});

/** fmtp params placed in our local description (what we want to receive). */
export function receiveParams() {
  return {
    stereo: 1,
    'sprop-stereo': 1,
    maxaveragebitrate: OPUS_MAX_BITRATE,
    maxplaybackrate: 48000,
    'sprop-maxcapturerate': 48000,
    useinbandfec: 1,
  };
}

/** fmtp params placed in the remote description (configures our encoder). */
export function sendParams(quality = DEFAULT_QUALITY) {
  const q = { ...DEFAULT_QUALITY, ...quality };
  const frameMs = VALID_FRAME_SIZES.includes(Number(q.frameMs)) ? Number(q.frameMs) : 10;
  return {
    params: {
      stereo: q.stereo ? 1 : 0,
      'sprop-stereo': q.stereo ? 1 : 0,
      maxaveragebitrate: clampBitrate(q.bitrate),
      maxplaybackrate: 48000,
      useinbandfec: q.fec ? 1 : 0,
      usedtx: q.dtx ? 1 : 0,
      cbr: q.cbr ? 1 : 0,
      minptime: frameMs,
    },
    ptime: frameMs,
  };
}

export function clampBitrate(bps) {
  const n = Math.round(Number(bps));
  if (!Number.isFinite(n)) return DEFAULT_QUALITY.bitrate;
  return Math.min(OPUS_MAX_BITRATE, Math.max(6000, n));
}

function parseFmtp(value) {
  const params = new Map();
  for (const part of value.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) params.set(trimmed, null);
    else params.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return params;
}

function formatFmtp(params) {
  return [...params].map(([k, v]) => (v === null ? k : `${k}=${v}`)).join(';');
}

/**
 * Rewrite the Opus fmtp line(s) and ptime of every audio section in an SDP.
 * @param {string} sdp
 * @param {Record<string, string|number|null>} params  fmtp values (null removes a key)
 * @param {number} [ptime] packet time in ms (adds/replaces a=ptime)
 * @returns {string}
 */
export function tuneOpus(sdp, params, ptime) {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();

  // Split into session part + media sections.
  const sections = [[]];
  for (const line of lines) {
    if (line.startsWith('m=')) sections.push([]);
    sections[sections.length - 1].push(line);
  }

  const out = [];
  for (const section of sections) {
    if (!section[0] || !section[0].startsWith('m=audio')) {
      out.push(...section);
      continue;
    }
    const opusPts = section
      .map((l) => /^a=rtpmap:(\d+) opus\/48000/i.exec(l))
      .filter(Boolean)
      .map((m) => m[1]);

    let result = section.filter((l) => !(ptime && /^a=ptime:/.test(l)));
    for (const pt of opusPts) {
      const fmtpIdx = result.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
      const current = fmtpIdx === -1 ? new Map() : parseFmtp(result[fmtpIdx].slice(`a=fmtp:${pt} `.length));
      for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined) current.delete(key);
        else current.set(key, String(value));
      }
      const line = `a=fmtp:${pt} ${formatFmtp(current)}`;
      if (fmtpIdx !== -1) {
        result[fmtpIdx] = line;
      } else {
        const rtpmapIdx = result.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
        result.splice(rtpmapIdx + 1, 0, line);
      }
    }
    if (ptime && opusPts.length) {
      // a=ptime belongs after the codec attributes; appending to the section is valid.
      result.push(`a=ptime:${ptime}`);
    }
    out.push(...result);
  }
  return out.join(eol) + eol;
}

/** Make Opus the first (preferred) audio codec in every audio m-line. */
export function preferOpus(sdp) {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  let opusPt = null;
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(l);
    if (m) {
      opusPt = m[1];
      break;
    }
  }
  if (!opusPt) return sdp;
  return lines
    .map((l) => {
      if (!l.startsWith('m=audio')) return l;
      const parts = l.split(' ');
      const header = parts.slice(0, 3);
      const pts = parts.slice(3).filter((p) => p !== opusPt);
      return [...header, opusPt, ...pts].join(' ');
    })
    .join(eol);
}

/** Read back the effective Opus parameters of an SDP (used for diagnostics). */
export function readOpusParams(sdp) {
  const lines = sdp.split(/\r?\n/);
  const rtpmap = lines.map((l) => /^a=rtpmap:(\d+) opus\/48000/i.exec(l)).find(Boolean);
  if (!rtpmap) return null;
  const fmtp = lines.find((l) => l.startsWith(`a=fmtp:${rtpmap[1]} `));
  const params = fmtp ? Object.fromEntries(parseFmtp(fmtp.slice(`a=fmtp:${rtpmap[1]} `.length))) : {};
  const ptimeLine = lines.find((l) => l.startsWith('a=ptime:'));
  return { pt: Number(rtpmap[1]), params, ptime: ptimeLine ? Number(ptimeLine.slice(8)) : null };
}
