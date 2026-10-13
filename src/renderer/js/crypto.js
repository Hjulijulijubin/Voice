/**
 * Cryptography for rooms. No accounts, no servers.
 *
 *  - A room is just a random 256-bit secret. The invite code *is* the secret,
 *    so anyone holding the code is a member, and nobody else can read anything.
 *  - All keys are derived from the secret with HKDF-SHA256:
 *      roomId  public-ish identifier (local storage key)
 *      topic   rendezvous tag (what relays / LAN see; reveals nothing)
 *      sigKey  AES-256-GCM for rendezvous handshakes (authenticates the SDP,
 *              and with it the DTLS fingerprints → no man-in-the-middle)
 *      dataKey AES-256-GCM for every message/file chunk routed through peers
 *      mediaKey AES-256-GCM for audio packets routed through peers
 *  - Every member has an Ed25519 key pair per room (no account). Chat
 *    messages and room changes are signed, so members can't impersonate
 *    each other.
 *
 * Uses only WebCrypto, so it runs in the renderer, workers and Node tests.
 */

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const INVITE_PREFIX = 'voice:';

// ------------------------------------------------------------------ encoding
export function b64uEncode(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 0x8000) bin += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function randomHex(nBytes) {
  return toHex(randomBytes(nBytes));
}

/** JSON with sorted keys, so signatures are stable across peers. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', typeof bytes === 'string' ? te.encode(bytes) : bytes));
}

// ------------------------------------------------------------------ invites
export function createInvite() {
  const secret = randomBytes(32);
  return { secret, code: INVITE_PREFIX + b64uEncode(secret) };
}

/** Accepts "voice:XXXX", "voice://join/XXXX" or just "XXXX". */
export function parseInvite(code) {
  const trimmed = String(code || '').trim();
  const m = /^(?:voice:(?:\/\/join\/)?)?([A-Za-z0-9_-]{43})$/.exec(trimmed);
  if (!m) throw new Error('This is not a valid invite code');
  const secret = b64uDecode(m[1]);
  if (secret.length !== 32) throw new Error('This is not a valid invite code');
  return secret;
}

export function inviteFromSecret(secret) {
  return INVITE_PREFIX + b64uEncode(secret);
}

// ------------------------------------------------------------------ room keys
async function hkdf(secret, info, bits = 256) {
  const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const out = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('voice-room-v1'), info: te.encode(info) }, base, bits);
  return new Uint8Array(out);
}

async function aesKey(raw) {
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function deriveRoomKeys(secret) {
  const [idBits, topicBits, sig, data, media] = await Promise.all([
    hkdf(secret, 'room-id', 64),
    hkdf(secret, 'rendezvous-topic', 256),
    hkdf(secret, 'signal-key'),
    hkdf(secret, 'data-key'),
    hkdf(secret, 'media-key'),
  ]);
  return {
    roomId: toHex(idBits),
    topic: toHex(topicBits),
    sigKey: await aesKey(sig),
    dataKey: await aesKey(data),
    mediaKeyRaw: media,
  };
}

// ------------------------------------------------------------------ AES-GCM
/** Encrypt → [12-byte IV | ciphertext+tag]. */
export async function seal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const data = typeof plaintext === 'string' ? te.encode(plaintext) : plaintext;
  const params = { name: 'AES-GCM', iv };
  if (aad) params.additionalData = typeof aad === 'string' ? te.encode(aad) : aad;
  const ct = new Uint8Array(await subtle.encrypt(params, key, data));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function open(key, sealed, aad) {
  const bytes = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed);
  const params = { name: 'AES-GCM', iv: bytes.subarray(0, 12) };
  if (aad) params.additionalData = typeof aad === 'string' ? te.encode(aad) : aad;
  return new Uint8Array(await subtle.decrypt(params, key, bytes.subarray(12)));
}

export async function sealJson(key, obj, aad) {
  return b64uEncode(await seal(key, JSON.stringify(obj), aad));
}

export async function openJson(key, b64, aad) {
  return JSON.parse(td.decode(await open(key, b64uDecode(b64), aad)));
}

// ------------------------------------------------------------------ identity
export async function peerIdFromPub(pubB64) {
  return toHex((await sha256(b64uDecode(pubB64))).subarray(0, 8));
}

/** New per-room identity; returns a JSON-serialisable record. */
export async function generateIdentity() {
  const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = b64uEncode(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const priv = b64uEncode(new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey)));
  return { pub, priv };
}

export async function loadIdentity(record) {
  const privateKey = await subtle.importKey('pkcs8', b64uDecode(record.priv), { name: 'Ed25519' }, false, ['sign']);
  return { id: await peerIdFromPub(record.pub), pub: record.pub, privateKey };
}

const pubKeyCache = new Map();

export async function signObject(identity, obj) {
  const sig = await subtle.sign('Ed25519', identity.privateKey, te.encode(canonical(obj)));
  return b64uEncode(new Uint8Array(sig));
}

export async function verifyObject(pubB64, obj, sigB64) {
  try {
    let key = pubKeyCache.get(pubB64);
    if (!key) {
      key = await subtle.importKey('raw', b64uDecode(pubB64), { name: 'Ed25519' }, false, ['verify']);
      if (pubKeyCache.size > 500) pubKeyCache.clear();
      pubKeyCache.set(pubB64, key);
    }
    return await subtle.verify('Ed25519', key, b64uDecode(sigB64), te.encode(canonical(obj)));
  } catch {
    return false;
  }
}
