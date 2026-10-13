# Voice

An open source alternative to Discord and TeamSpeak for **Windows, macOS and Linux**, with:

- **No accounts and no servers.** You create a room and get an invite code. Send the code through any other chat; whoever has it is in.
- **End-to-end encryption.** Voice, chat and files are encrypted between members. Nothing readable ever reaches a third party.
- **Latency-optimized routing.** Audio and data take the fastest path through the group. If going through a friend is faster than the direct connection, or a direct connection is impossible, traffic is relayed automatically, still encrypted.
- **Opus with very low delay and high bitrate.** 10 ms frames over WebRTC (up to 510 kbps stereo). An optional ultra-low-latency mode uses 2.5–5 ms frames.
- **Files stored on every member's PC.** When everyone has deleted a file from their PC, it disappears from the chat.
- **Low resource use.** Near-zero CPU when idle; audio threads only run while you're in voice.

![Voice: a room with three members, one of them reached through another member](docs/screenshot.png)

## Download

Installers for every platform are on the [**Releases page**](https://github.com/hjulijulijubin/voice/releases):

| Platform | File |
|---|---|
| Windows (x64 / ARM64) | `Voice-Setup-<version>-x64.exe` / `-arm64.exe`, or `Voice-Portable-<version>.exe` (no install) |
| macOS (Apple Silicon / Intel) | `Voice-<version>-mac-arm64.dmg` / `-x64.dmg` |
| Linux (x64) | `Voice-<version>-linux-x86_64.AppImage`, `.deb` or `.tar.gz` |

> The builds are not code-signed (that costs money per platform).
> - **Windows:** in SmartScreen, click *More info → Run anyway*.
> - **macOS:** right-click the app → *Open*. If macOS says the app is damaged, run `xattr -cr /Applications/Voice.app` once.
> - **Linux:** for the AppImage, run `chmod +x Voice-*.AppImage`.

## How to use it

1. Start Voice and choose a display name.
2. **Create a room.** You get an invite code like `voice:Q2xhdWRlIG1hZGUgdGhpcyBmb3IgeW91IQ…`.
3. Send the code to your friends via WhatsApp, Signal, email or anything else. They click **Join with an invite code** and paste it. Clicking a `voice:` link opens the app directly.
4. Chat in text channels, share files by dragging them into the chat, and click a voice channel to talk.

Rooms persist on your PC: reopen the app and you're back in all your rooms. Your history syncs from the other members.

## How it works

```
                 ┌──────────────── finding each other ────────────────┐
                 │  public Nostr relays (encrypted blobs)  │  LAN multicast │
                 └────────▲────────────────▲───────────────▲──────────┘
                          │                │               │   only a random-looking room
                          │                │               │   hash + ciphertext
                     ┌────┴───┐       ┌────┴───┐      ┌────┴───┐
                     │ Alice  │◄─────►│  Sam   │◄────►│ Jordan │   direct, encrypted WebRTC
                     └────────┘       └────────┘      └────────┘
                          ▲                                ▲
                          └──── slow / impossible ─────────┘   → Alice↔Jordan is routed via Sam
```

### No accounts and no servers

A room is just a random 256-bit secret, and the invite code *is* that secret. Every key is derived from it with HKDF:

| Derived key | Used for |
|---|---|
| room topic | The only thing the rendezvous relays see: a hash that reveals nothing about the room |
| signalling key (AES-256-GCM) | Encrypts and authenticates connection handshakes |
| data key (AES-256-GCM) | Encrypts messages and file chunks that pass through other members |
| media key (AES-256-GCM) | Encrypts audio packets that pass through other members |

Members need some way to find each other on the internet. Voice uses **public [Nostr](https://nostr.com) relays** as a meeting point:
- It publishes short-lived, encrypted handshake events on the room topic. The relays forward them live and store nothing.
- Each app session signs these events with a throwaway key, so nothing links them to you.
- On a local network, **LAN multicast** finds members with no internet at all.
- You can also run your own tiny relay (see below) or add any other Nostr relay in *Settings → Network*.

After the handshake, everything goes **directly between members**. New connections inside a room are negotiated through the member mesh itself, not the relays.

Each member has a per-room **Ed25519 identity**, generated locally. There's no account, phone number or email. Messages, room changes (channel list, name) and file records are **signed**, so members can't impersonate each other.

### End-to-end encryption

- **Direct connections:** WebRTC (DTLS-SRTP for audio, DTLS-SCTP for data). The handshakes are encrypted and authenticated with the room key, so the DTLS fingerprints can't be swapped: no man-in-the-middle, not even by a relay.
- **Anything routed through another member:** encrypted again with the room's AES-256-GCM keys before it leaves the sender:
  - Chat and control messages are sealed envelopes.
  - Audio packets carry a per-stream nonce and authenticated header.
  - File chunks are encrypted individually.
- **Files** are also verified against the SHA-256 hash the uploader signed.

### Smart routing

Every peer measures the round-trip time to each member it's connected to (about every 2 s while in voice) and shares these measurements with the room (link-state routing). Every peer then knows the whole network and computes the fastest path to each member using Dijkstra's algorithm on one-way latency, with a small cost for each extra hop.

- **Voice:**
  - The *sender* picks a route for each listener.
  - Direct WebRTC is used unless relaying through one or more members is faster by a clear margin (≥ 10 ms and ≥ 15%). This hysteresis prevents route flapping.
  - If no direct connection is possible (strict or symmetric NAT), audio is always relayed, so you rarely need a TURN server.
  - Relaying members forward the encrypted packets without decoding them. This costs about 0 ms of processing and they can't listen in.
- **Chat, file transfers and connection handshakes** use the same routes.
- In *Settings → Network* you can choose whether your connection may relay for others.

The member list shows each route live, for example `direct · 12 ms` or `via Sam · 19 ms`.

### Audio quality and latency

There are two audio paths:

| | **Direct WebRTC** (default for direct links) | **Custom pipeline** (relayed routes, and "Ultra" mode) |
|---|---|---|
| Codec | Opus via WebRTC | Opus via WebCodecs, in a worker |
| Frame size | 10 ms (minimum WebRTC allows) | 2.5, 5 or 10 ms |
| Bitrate | up to 510 kbps, stereo, FEC | same |
| Jitter buffer | WebRTC NetEq, target set to minimum | Own adaptive buffer: frame + 3× measured jitter, catches up when ahead |
| Packet loss | NetEq concealment + Opus FEC | Fade-out concealment + Opus FEC |
| Encryption | DTLS-SRTP | AES-256-GCM end-to-end (+ DTLS per hop) |

**Opus tuning.** WebRTC configures the Opus encoder from the fmtp parameters the *remote* side advertises. Voice rewrites SDP in both directions:
- Each side advertises that it can receive 510 kbps full-band stereo.
- Before applying the other side's description, Voice inserts **your own** send settings: bitrate, frame size, stereo, FEC, DTX and CBR.

Each person therefore controls the quality they send, and changes apply live. See [`opus.js`](src/renderer/js/opus.js).

**Capture.** The raw microphone track goes straight into WebRTC. Voice activity detection and the transmit gate run on the real-time audio thread (an AudioWorklet), with no main-thread timers. The custom pipeline taps PCM there and sends it straight to the media worker.

**Presets** (*Settings → Opus Quality*):

| Preset | Settings | Use |
|---|---|---|
| Voice chat | Echo cancellation and noise suppression on, 128 kbps mono | Speakers, laptops |
| Hi-Fi / Music | No processing, 510 kbps stereo | Headphones, instruments, music |
| Bad connection | 64 kbps, 20 ms frames, FEC | Weak Wi-Fi |

**Verified by the automated end-to-end test:**
- Direct WebRTC: 100 packets/s (10 ms frames) at 256 kbps stereo.
- Relayed audio: forwarded through a third member and decoded with no loss.
- Ultra mode: 200 packets/s (5 ms frames).

### Files: stored on every PC, gone when everyone deletes them

- Files are written to disk in chunks, never held fully in memory:
  - Windows: `%APPDATA%/Voice/rooms/<room>/files/`
  - macOS: `~/Library/Application Support/Voice/rooms/…`
  - Linux: `~/.config/Voice/rooms/…`
- Every member **automatically stores** new files up to a size you choose (default 50 MB; *Settings → Network & Files*). Larger files download on click.
- Downloads come from the **fastest** member who has the file, directly or through relays. They use flow-controlled 2 MB windows, resume from another member if the source goes offline, and are checked against the signed SHA-256.
- Each member publishes a signed record per file: *I have it* or *I deleted it*.
  - The file card shows how many devices store it.
  - **When the last member deletes it, it disappears from the chat for everyone.**
  - Leaving a room deletes your copies and un-announces them.
- Images, audio and video preview inline, straight from disk. You can also *Save a copy*, *Open*, or *Delete from this PC* (the room menu lists everything stored).

### Resource use

Measured on a 2-core cloud VM with software rendering:
- **Idle:** about 1% CPU.
- **In a call:** about 20% CPU.
- **Memory:** about 220–260 MB total (PSS, all processes).

Real desktops with hardware audio and GPU use considerably less. The main savings:
- **No audio threads unless needed.**
  - Remote audio is only attached while you're in voice with that person.
  - UI sounds release the sound card after 1.5 s.
  - The custom pipeline's worker and playback context start on demand and shut down after 15 s idle.
- **No polling when idle.**
  - Level meters only produce data while a meter is visible.
  - Latency probes slow to every 6 s outside voice.
  - Typing indicators only tick while someone types.
- **Efficient data handling.**
  - History sync compares per-day hashes and only transfers the days that differ, one member at a time.
  - Database writes are batched.
- **No unnecessary downloads.** Spellcheck (which downloads dictionaries) and the spare renderer process are disabled.
- **Optional low-resource mode** (*Settings → Profile*) turns off GPU acceleration.

## Features

- Multiple rooms, each with its own text and voice channels (create, rename, delete).
- Signed messages with **bold**, `code`, fenced code blocks, links, @mentions with notifications, typing indicators, and history that scrolls back.
- Push-to-talk that works globally, even in games; any key or mouse button 4/5. On macOS, allow Voice under *Privacy & Security → Accessibility*. On Linux this needs X11; on Wayland it works while the window is focused.
- Voice activation with a live meter and threshold, mute and deafen (`Ctrl/⌘+Shift+M` / `D`), and "hear myself" mic test.
- Per-user volume and "mute for me".
- Live connection details per member: route, round trip, bitrate, loss, jitter buffer, negotiated codec and encoder fmtp.
- `voice:` invite links open the app. Several profiles on one PC are possible with `--profile=name`.

## Optional: run your own rendezvous relay

You don't need this, because public relays and LAN discovery work out of the box. If you prefer a private meeting point:

```bash
node server/index.js --port 7777
# or
docker build -t voice-relay . && docker run -d -p 7777:7777 voice-relay
```

Add `ws://your-host:7777` (or `wss://` behind a TLS proxy) under *Settings → Network → Rendezvous relays*. It's a minimal Nostr relay that only forwards ephemeral events and stores nothing.

**Strict networks.** If two members can't connect directly *and* no other member can relay between them, add a TURN server (e.g. coturn) under *Settings → Network*.

## Security notes

- **The invite code is the room key.** Anyone holding it can join and read the room, and it can't be revoked. If it leaks, create a new room.
- Members can see each other's IP addresses, as in any peer-to-peer app.
- Stored history and files are not encrypted at rest. Use full-disk encryption.
- The renderer runs sandboxed with context isolation and a strict CSP. Links open in your browser.

## Development

```bash
npm install
npm start                       # run from source (Node 20+)
npm test                        # unit tests: crypto, routing, Opus SDP, relay, file store
xvfb-run -a npm run test:e2e    # 3 real app instances: invite, chat, relay routing, voice,
                                # ultra mode, file replication, delete-everywhere, history sync
E2E_RELAYS=wss://nos.lol npm run test:e2e   # same, over public Nostr relays
npm run dist                    # build installers for the current OS into dist/
```

```
src/main/        Electron main: window, rendezvous (Nostr + LAN), file store, global PTT
src/server/      Optional minimal Nostr relay
src/renderer/js/
  app.js           UI
  room.js          Room: signed messages/ops, history sync
  overlay.js       Peer mesh: WebRTC, link-state routing, forwarding
  routing.js       Dijkstra + route hysteresis (pure)
  crypto.js        Invite codes, HKDF, AES-GCM, Ed25519
  files.js         Replicated file storage and transfers
  audio.js         Mic capture + AudioWorklet VAD/gate
  media.js, media-worker.js, worklets/   Custom Opus pipeline
  opus.js          SDP tuning for WebRTC's Opus
```

Pushing a tag `v*` builds the Windows, macOS and Linux installers in GitHub Actions and attaches them to a release.

## License

GPL-3.0. See [LICENSE](LICENSE).
