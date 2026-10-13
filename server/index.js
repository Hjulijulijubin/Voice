#!/usr/bin/env node
'use strict';

/**
 * Standalone Voice signaling server.
 *
 *   node server/index.js --port 9987 --name "My Server" --password secret
 *
 * Options can also be given as environment variables:
 *   VOICE_PORT, VOICE_HOST, VOICE_NAME, VOICE_PASSWORD, VOICE_MAX_PEERS,
 *   VOICE_STATE_FILE, VOICE_TURN_URL, VOICE_TURN_USER, VOICE_TURN_PASS
 */

const path = require('node:path');
const { SignalingServer } = require('../src/server/signaling');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`Voice signaling server

Usage: node server/index.js [options]

  --port <n>          Port to listen on (default 9987)
  --host <addr>       Interface to bind (default 0.0.0.0)
  --name <name>       Server name shown to clients
  --password <pw>     Require a password to join
  --max-peers <n>     Maximum simultaneous users (default 64)
  --state-file <f>    Where to persist the channel list (default ./voice-server.json)
  --turn-url <url>    TURN server pushed to clients, e.g. turn:turn.example.com:3478
  --turn-user <u>     TURN username
  --turn-pass <p>     TURN credential
`);
  process.exit(0);
}

const env = process.env;
const iceServers = [];
const turnUrl = args['turn-url'] || env.VOICE_TURN_URL;
if (turnUrl) {
  iceServers.push({
    urls: turnUrl,
    username: args['turn-user'] || env.VOICE_TURN_USER,
    credential: args['turn-pass'] || env.VOICE_TURN_PASS,
  });
}

const server = new SignalingServer({
  port: Number(args.port || env.VOICE_PORT || 9987),
  host: args.host || env.VOICE_HOST || '0.0.0.0',
  name: args.name || env.VOICE_NAME || 'Voice Server',
  password: args.password || env.VOICE_PASSWORD || '',
  maxPeers: Number(args['max-peers'] || env.VOICE_MAX_PEERS || 64),
  stateFile: path.resolve(args['state-file'] || env.VOICE_STATE_FILE || 'voice-server.json'),
  iceServers,
});

server.on('log', (line) => console.log(`[${new Date().toISOString()}] ${line}`));

server.start().then(
  ({ port }) => console.log(`Voice server "${server.name}" ready. Clients connect to ws://<this-host>:${port}`),
  (err) => {
    console.error(`Failed to start: ${err.message}`);
    process.exit(1);
  },
);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.stop().then(() => process.exit(0)));
}
