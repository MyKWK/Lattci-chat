import { parseArgs } from 'node:util';
import { initProfile, profilePath, readProfile } from './profile.mjs';
import { callLocal } from './local.mjs';
import { serve } from './daemon.mjs';
import { manageService } from './service.mjs';
import { startMcp } from './mcp.mjs';

const usage = `晶格 Lattice
  init [--name NAME] [--bind IP] [--peer-port PORT] [--local-port PORT]
       [--workspace DIR --codex ABSOLUTE_PATH] [--workspace-write] [--identity-source SCRIPT]
  serve | service enable|disable|status
  identity | status | inbox | message ID | resend ID
  pair PEER_ID --name NAME [--address wss://HOST:PORT]
  permission PEER_ID none|full
  send notice|request --to PEER_ID [--to PEER_ID] --body TEXT
  approve MESSAGE_ID | reject MESSAGE_ID | reply MESSAGE_ID --body TEXT
  mcp
`;

async function main() {
  const { values, positionals: [command, first, second] } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' }, bind: { type: 'string' }, address: { type: 'string' },
      'local-port': { type: 'string' }, 'peer-port': { type: 'string' },
      workspace: { type: 'string' }, codex: { type: 'string' }, 'workspace-write': { type: 'boolean' },
      'identity-source': { type: 'string' },
      to: { type: 'string', multiple: true }, body: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (!command || values.help) return process.stdout.write(usage);
  if (command === 'mcp') return startMcp();
  const directory = profilePath();
  if (command === 'init') {
    const { id, name, localPort, peerPort, bind } = initProfile(directory, values);
    return print({ id, name, localPort, peerPort, bind });
  }
  if (command === 'identity' || command === 'serve' || command === 'service') {
    const profile = readProfile(directory);
    if (command === 'identity') return print({ id: profile.id, name: profile.name });
    if (command === 'service') return print(manageService(profile, first));
    const daemon = await serve(profile);
    process.once('SIGINT', () => void daemon.stop());
    process.once('SIGTERM', () => void daemon.stop());
    return;
  }
  const calls = {
    status: ['status'],
    inbox: ['inbox'],
    message: ['message', { id: first }],
    resend: ['resend', { id: first }],
    pair: ['pair', { id: first, name: values.name, address: values.address }],
    permission: ['permission', { id: first, level: second }],
    send: ['send', { kind: first, peers: values.to, body: values.body }],
    approve: ['decision', { id: first, approve: true }],
    reject: ['decision', { id: first, approve: false }],
    reply: ['reply', { id: first, body: values.body }],
  };
  if (!Object.hasOwn(calls, command)) throw new Error('未知命令。使用 --help 查看用法。');
  print(await callLocal(...calls[command]));
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

main().catch((error) => {
  console.error('Lattice:', error.message);
  process.exitCode = 1;
});
