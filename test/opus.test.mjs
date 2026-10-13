import test from 'node:test';
import assert from 'node:assert/strict';
import { tuneOpus, receiveParams, sendParams, readOpusParams, clampBitrate, preferOpus } from '../src/renderer/js/opus.js';

// Trimmed real-world Chromium offer.
const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=sendrecv',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  'a=rtpmap:0 PCMU/8000',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=sctp-port:5000',
  '',
].join('\r\n');

test('receive params advertise full-band stereo at 510 kbps', () => {
  const out = tuneOpus(SDP, receiveParams());
  const opus = readOpusParams(out);
  assert.equal(opus.pt, 111);
  assert.equal(opus.params.stereo, '1');
  assert.equal(opus.params.maxaveragebitrate, '510000');
  assert.equal(opus.params.maxplaybackrate, '48000');
  assert.equal(opus.params.useinbandfec, '1');
  assert.equal(opus.params.minptime, '10', 'existing params are kept');
  assert.ok(out.endsWith('\r\n'));
  assert.ok(!out.includes('\n\n'));
  // Other codecs untouched.
  assert.ok(out.includes('a=fmtp:63 111/111'));
});

test('send params configure bitrate, frame size, fec, dtx, cbr', () => {
  const { params, ptime } = sendParams({ bitrate: 320000, stereo: false, frameMs: 20, fec: false, dtx: true, cbr: true });
  const out = tuneOpus(SDP, params, ptime);
  const opus = readOpusParams(out);
  assert.equal(opus.params.maxaveragebitrate, '320000');
  assert.equal(opus.params.stereo, '0');
  assert.equal(opus.params.useinbandfec, '0');
  assert.equal(opus.params.usedtx, '1');
  assert.equal(opus.params.cbr, '1');
  assert.equal(opus.params.minptime, '20');
  assert.equal(opus.ptime, 20);
  // ptime must land in the audio section, not the data section.
  const audioSection = out.split('m=application')[0];
  assert.ok(audioSection.includes('a=ptime:20'));
});

test('tuning is idempotent (no duplicate ptime/fmtp lines)', () => {
  const { params, ptime } = sendParams({ frameMs: 10 });
  const once = tuneOpus(SDP, params, ptime);
  const twice = tuneOpus(once, params, ptime);
  assert.equal(once, twice);
  assert.equal(twice.match(/a=ptime:/g).length, 1);
  assert.equal(twice.match(/a=fmtp:111 /g).length, 1);
});

test('fmtp line is created when missing', () => {
  const noFmtp = SDP.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', '');
  const out = tuneOpus(noFmtp, { stereo: 1 });
  const lines = out.split('\r\n');
  const idx = lines.indexOf('a=rtpmap:111 opus/48000/2');
  assert.equal(lines[idx + 1], 'a=fmtp:111 stereo=1');
});

test('invalid frame sizes fall back to 10 ms, bitrate is clamped', () => {
  assert.equal(sendParams({ frameMs: 7 }).ptime, 10);
  assert.equal(clampBitrate(9e9), 510000);
  assert.equal(clampBitrate(1), 6000);
  assert.equal(clampBitrate('nope'), 256000);
});

test('preferOpus moves opus to the front', () => {
  const reordered = SDP.replace('SAVPF 111 63 9', 'SAVPF 9 63 111');
  assert.ok(preferOpus(reordered).includes('m=audio 9 UDP/TLS/RTP/SAVPF 111 9 63'));
});

test('SDP without opus is left alone', () => {
  const pcmu = 'v=0\r\nm=audio 9 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n';
  assert.equal(tuneOpus(pcmu, { stereo: 1 }, 10), pcmu);
});
