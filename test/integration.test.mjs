import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test } from 'node:test';

const run = promisify(execFile);
const runtime = fileURLToPath(new URL('../plugins/lattci-chat/lattice.cjs', import.meta.url));
const testAddress = process.env.LATTICE_TEST_LAN
  ? Object.values(networkInterfaces()).flat().find((network) => network.family === 'IPv4' && !network.internal && /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(network.address))?.address
  : '127.0.0.1';
if (!testAddress) throw new Error('未找到局域网 IPv4 地址');

async function twoPorts() {
  const probes = Array.from({ length: 2 }, () => createServer());
  try {
    await Promise.all(probes.map((probe) => new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    })));
    return probes.map((probe) => String(probe.address().port));
  } finally {
    await Promise.all(probes.map((probe) => new Promise((resolve) => probe.close(resolve))));
  }
}

async function eventually(check, timeout = 9000) {
  const until = Date.now() + timeout;
  let error;
  while (Date.now() < until) {
    try {
      const result = await check();
      if (result) return result;
    } catch (caught) {
      error = caught;
    }
    await delay(100);
  }
  throw new Error('条件未满足', { cause: error });
}

test('independent WSS processes, MCP, permissions and manual resend', { timeout: 90000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'lattice-integration-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, 'workspace');
  await mkdir(workspace);
  const mock = join(base, 'mock-codex');
  await writeFile(mock, '#!/bin/sh\nprintf "processed: " \ncat\n', { mode: 0o700 });

  const processes = new Set();
  const clients = new Set();
  t.after(async () => {
    await Promise.all([...clients].map((client) => client.close()));
    await Promise.all([...processes].map(stop));
  });

  async function create(name, runner = mock, identitySource) {
    const [local, peer] = await twoPorts();
    const env = { ...process.env, LATTICE_HOME: join(base, name) };
    const cmd = async (...args) => {
      const result = await run(process.execPath, [runtime, ...args], { env, timeout: 7000 });
      return JSON.parse(result.stdout);
    };
    const { id } = await cmd('init', '--name', name, '--local-port', local, '--peer-port', peer,
      '--bind', testAddress, '--workspace', workspace, '--codex', runner,
      ...(identitySource ? ['--identity-source', identitySource] : []));
    const start = async () => {
      const child = spawn(process.execPath, [runtime, 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      processes.add(child);
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('exit', () => processes.delete(child));
      try { await eventually(() => cmd('status')); }
      catch (error) { throw new Error(stderr, { cause: error }); }
      return child;
    };
    return { id, cmd, start, env, address: 'wss://' + testAddress + ':' + peer };
  }

  const { privateKey: key } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const cert = spawnSync('openssl', ['req', '-x509', '-new', '-key', '/dev/stdin',
    '-subj', '/CN=Lattice-test', '-days', '1'], { input: key, encoding: 'utf8' });
  assert.equal(cert.status, 0);
  const invite = join(base, 'invite.cjs');
  await writeFile(invite, 'const invitationIdentity = ' + JSON.stringify({ key, cert: cert.stdout }) + ';\n', { mode: 0o600 });
  const [a, b, c] = [await create('A'), await create('B', mock, invite), await create('C', process.env.LATTICE_TEST_CODEX || mock)];
  assert.deepEqual(await readdir(b.env.LATTICE_HOME), ['settings.json']);
  await a.start();
  let bProcess = await b.start();
  await c.start();
  await a.cmd('pair', b.id, '--name', 'B', '--address', b.address);
  await delay(300);
  assert.equal((await a.cmd('status')).peers[0].connected, false);
  await b.cmd('pair', a.id, '--name', 'A');
  await c.cmd('pair', a.id, '--name', 'A');
  await a.cmd('pair', c.id, '--name', 'C', '--address', c.address);
  await eventually(async () => (await a.cmd('status')).peers.every((peer) => peer.connected));
  const wrongIdentity = 'f'.repeat(64);
  await a.cmd('pair', wrongIdentity, '--name', 'Wrong identity', '--address', b.address);
  await eventually(async () => (await a.cmd('status')).peers.find((peer) => peer.id === wrongIdentity)?.lastError === 'identity_mismatch');

  const client = new Client({ name: 'lattice-integration', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [runtime, 'mcp'], env: b.env });
  await client.connect(transport);
  clients.add(client);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(),
    ['inbox', 'message_status', 'reply', 'resend', 'send_message', 'status']);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  assert.equal((await call('status')).id, b.id);
  await eventually(async () => (await call('status')).agentOnline);
  const [fromB] = await call('send_message', { peers: [a.id], kind: 'notice', body: 'B to A' });
  await eventually(async () => (await a.cmd('inbox')).some((row) => row.id === fromB.id));
  assert.equal((await b.cmd('message', fromB.id)).message.state, 'sent');

  const broadcast = await a.cmd('send', 'notice', '--to', b.id, '--to', c.id, '--body', 'group notification');
  assert.equal(broadcast.length, 2);
  await eventually(async () => (await b.cmd('inbox')).some((row) => row.id === broadcast[0].id));
  await eventually(async () => (await c.cmd('inbox')).some((row) => row.id === broadcast[1].id));

  const [manual] = await a.cmd('send', 'request', '--to', b.id, '--body', 'manual request');
  await eventually(async () => (await b.cmd('message', manual.id)).message.state === 'awaiting_approval');
  await assert.rejects(b.cmd('reply', manual.id, '--body', 'attempt to bypass approval'), /仅可回复/);
  assert.equal((await a.cmd('message', manual.id)).replies.length, 0);
  await b.cmd('approve', manual.id);
  const approved = await eventually(async () => (await a.cmd('message', manual.id)).replies[0]);
  assert.equal(approved.body, 'processed: manual request');

  const [denied] = await a.cmd('send', 'request', '--to', b.id, '--body', 'reject this');
  await eventually(async () => (await b.cmd('message', denied.id)).message.state === 'awaiting_approval');
  await b.cmd('reject', denied.id);
  assert.match((await eventually(async () => (await a.cmd('message', denied.id)).replies[0])).body, /拒绝/);

  await b.cmd('permission', a.id, 'full');
  const [automatic] = await a.cmd('send', 'request', '--to', b.id, '--body', 'automatic request');
  assert.equal((await eventually(async () => (await a.cmd('message', automatic.id)).replies[0])).body,
    'processed: automatic request');

  await client.close();
  clients.delete(client);
  await eventually(async () => !(await b.cmd('status')).agentOnline);
  const [asleep] = await a.cmd('send', 'request', '--to', b.id, '--body', 'Agent unavailable');
  await eventually(async () => (await b.cmd('message', asleep.id)).message.state === 'queued');
  assert.equal((await a.cmd('message', asleep.id)).replies.length, 0);

  await stop(bProcess);
  await eventually(async () => !(await a.cmd('status')).peers.find((peer) => peer.id === b.id).connected);
  await eventually(async () => (await a.cmd('status')).peers.find((peer) => peer.id === b.id).lastError === 'ECONNREFUSED');
  const [offline] = await a.cmd('send', 'notice', '--to', b.id, '--body', 'receiver offline');
  assert.equal(offline.state, 'send_failed');
  bProcess = await b.start();
  await eventually(async () => (await a.cmd('status')).peers.find((peer) => peer.id === b.id).connected);
  assert.equal((await b.cmd('inbox')).some((row) => row.id === offline.id), false);
  assert.equal((await a.cmd('resend', offline.id)).state, 'sent');
  await eventually(async () => (await b.cmd('inbox')).some((row) => row.id === offline.id));
  assert.equal((await a.cmd('resend', offline.id)).state, 'sent');
  await delay(150);
  assert.equal((await b.cmd('inbox')).filter((row) => row.id === offline.id).length, 1);

  const reconnected = new Client({ name: 'lattice-reconnect', version: '1' });
  await reconnected.connect(new StdioClientTransport({ command: process.execPath, args: [runtime, 'mcp'], env: b.env }));
  clients.add(reconnected);
  assert.equal((await eventually(async () => (await a.cmd('message', asleep.id)).replies[0])).body,
    'processed: Agent unavailable');

  if (process.env.LATTICE_TEST_CODEX) {
    const real = new Client({ name: 'lattice-codex-test', version: '1' });
    await real.connect(new StdioClientTransport({ command: process.execPath, args: [runtime, 'mcp'], env: c.env }));
    clients.add(real);
    await c.cmd('permission', a.id, 'full');
    const [request] = await a.cmd('send', 'request', '--to', c.id,
      '--body', 'Reply with exactly LATTICE_CODEX_OK. Do not use tools.');
    const reply = await eventually(async () => (await a.cmd('message', request.id)).replies[0], 55000);
    assert.equal(reply.body.trim(), 'LATTICE_CODEX_OK');
    t.diagnostic('Real Codex CLI returned LATTICE_CODEX_OK over the peer connection');
  }
});

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}
