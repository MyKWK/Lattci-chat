import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { deviceDeclaration, initProfile, profilePath, readProfile, updateDescription } from './profile.mjs';
import { callLocal } from './local.mjs';
import { serve } from './daemon.mjs';
import { manageService } from './service.mjs';
import { startMcp } from './mcp.mjs';

const usage = `晶格 Lattice
  init [--name NAME] [--description TEXT] [--bind IP] [--peer-port PORT] [--local-port PORT]
       [--workspace DIR] [--codex ABSOLUTE_PATH] [--identity-source SCRIPT]
  serve | service enable|disable|status
  identity | status | inbox | message ID | resend ID
  profile --description TEXT
  pair LATTCI_CODE --name NAME --description TEXT [--address wss://HOST:PORT]
  permission PEER_ID none|full
  send notice|request --to PEER_ID [--to PEER_ID] --body TEXT
  approve MESSAGE_ID | reject MESSAGE_ID | reply MESSAGE_ID --body TEXT
  reviews | review APPROVAL_ID
  mcp
`;

async function main() {
  const { values, positionals: [command, first, second] } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' }, description: { type: 'string' }, bind: { type: 'string' }, address: { type: 'string' },
      'local-port': { type: 'string' }, 'peer-port': { type: 'string' },
      workspace: { type: 'string' }, codex: { type: 'string' }, 'workspace-write': { type: 'boolean' },
      'identity-source': { type: 'string' },
      to: { type: 'string', multiple: true }, body: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (!command || values.help) return process.stdout.write(usage);
  if (command === 'mcp') return startMcp();
  if (command === 'review') return reviewFileWrite(first);
  const directory = profilePath();
  if (command === 'init') {
    const profile = initProfile(directory, values);
    const { localPort, peerPort, bind } = profile;
    return print({ ...deviceDeclaration(profile), localPort, peerPort, bind });
  }
  if (['identity', 'profile', 'serve', 'service'].includes(command)) {
    const profile = readProfile(directory);
    if (command === 'identity') return print(deviceDeclaration(profile));
    if (command === 'profile') return print(updateDescription(profile, values.description));
    if (command === 'service') return print(manageService(profile, first));
    const daemon = await serve(profile);
    process.once('SIGINT', () => void daemon.stop());
    process.once('SIGTERM', () => void daemon.stop());
    return;
  }
  const calls = {
    status: ['status'],
    inbox: ['inbox'],
    reviews: ['file_reviews'],
    message: ['message', { id: first }],
    resend: ['resend', { id: first }],
    pair: ['pair_with_declaration', { id: first, name: values.name, description: values.description, address: values.address }],
    permission: ['permission', { id: first, level: second }],
    send: ['send', { kind: first, peers: values.to, body: values.body }],
    approve: ['decision', { id: first, approve: true }],
    reject: ['decision', { id: first, approve: false }],
    reply: ['reply', { id: first, body: values.body }],
  };
  if (!Object.hasOwn(calls, command)) throw new Error('未知命令。使用 --help 查看用法。');
  print(await callLocal(...calls[command]));
}

async function reviewFileWrite(id) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('请在本机终端中人工审批工作目录外写入');
  const reviews = await callLocal('file_reviews');
  const review = reviews.find((entry) => entry.id === id);
  if (!review) throw new Error('写入审批不存在，请用 reviews 查看待审批项');
  process.stderr.write(JSON.stringify(review, null, 2) + '\n');
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const decision = await terminal.question('输入「批准」为本次任务放行上列路径，输入「拒绝」拒绝此次申请。\n');
    if (decision !== '批准' && decision !== '拒绝') throw new Error('未提交审批决定');
    print(await callLocal('file_review', { id, approve: decision === '批准' }));
  } finally {
    terminal.close();
  }
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

main().catch((error) => {
  console.error('Lattice:', error.message);
  process.exitCode = 1;
});
