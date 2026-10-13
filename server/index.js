#!/usr/bin/env node
'use strict';

/**
 * Optional private rendezvous relay for Voice.
 *
 *   node server/index.js --port 7777
 *
 * Then add ws://<host>:7777 (or wss:// behind a TLS proxy) under
 * Settings → Network → Rendezvous relays in the app.
 */

const { Relay } = require('../src/server/relay');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

if (args.includes('--help')) {
  console.log('Usage: node server/index.js [--port 7777] [--host 0.0.0.0] [--name "My relay"]\nEnv: VOICE_RELAY_PORT, VOICE_RELAY_HOST');
  process.exit(0);
}

const relay = new Relay({
  port: Number(opt('port', process.env.VOICE_RELAY_PORT || 7777)),
  host: opt('host', process.env.VOICE_RELAY_HOST || '0.0.0.0'),
  name: opt('name', 'Voice relay'),
});
relay.on('log', (l) => console.log(`[${new Date().toISOString()}] ${l}`));
relay.start().then(
  ({ port }) => console.log(`Voice relay listening on ws://0.0.0.0:${port}`),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => relay.stop().then(() => process.exit(0)));
