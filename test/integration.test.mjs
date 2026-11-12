import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('independent WSS processes, MCP, permissions and manual resend', { timeout: 150000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'lattice-integration-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, 'workspace');
  await mkdir(workspace);
  const mock = join(base, 'mock-codex');
  await writeFile(mock, `#!${process.execPath}
const assert = require('node:assert/strict');
const { createInterface } = require('node:readline');
const send = (message) => console.log(JSON.stringify(message));
let input;
function complete(text) {
  send({ method: 'item/completed', params: { item: { type: 'agentMessage', text } } });
  send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params, result } = JSON.parse(line);
  switch (method) {
    case 'initialize': return send({ id, result: {} });
    case 'config/read': return send({ id, result: { config: {} } });
    case 'thread/start': {
      const { filesystem, network } = params.config.permissions[params.permissions];
      assert.equal(filesystem[':root'], 'read');
      assert.equal(filesystem[params.cwd], 'write');
      assert.equal(network.enabled, false);
      assert.equal(params.approvalPolicy.granular.request_permissions, true);
      assert.equal(params.approvalPolicy.granular.sandbox_approval, false);
      return send({ id, result: { thread: { id: 'test-thread' }, activePermissionProfile: { id: params.permissions },
        approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer } });
    }
    case 'mcpServerStatus/list': return send({ id, result: { data: [] } });
    case 'turn/start': {
      input = params.input[0].text;
      send({ id, result: {} });
      if (!input.startsWith('approval: ')) return complete('processed: ' + input);
      const path = input.slice('approval: '.length);
      return send({ id: 'approval', method: 'item/permissions/requestApproval', params: {
        permissions: { fileSystem: { write: [path] }, network: { enabled: true } }, reason: 'outside write',
      } });
    }
    default:
      if (id === 'approval') {
        assert.equal(result.scope, 'turn');
        assert.equal(result.permissions.network, undefined);
        return complete(result.permissions.fileSystem?.write[0] === input.slice('approval: '.length) ? 'approved' : 'denied');
      }
  }
});
`, { mode: 0o700 });

  const processes = new Set();
  const clients = new Set();
  t.after(async () => {
    await Promise.all([...clients].map((client) => client.close()));
    await Promise.all([...processes].map(stop));
  });

  async function create(name, runner = mock, identitySource, description, useDefaultWorkspace = false) {
    const [local, peer] = await twoPorts();
    const env = { ...process.env, LATTICE_HOME: join(base, name) };
    const cmd = async (...args) => {
      const result = await run(process.execPath, [runtime, ...args], { env, timeout: 7000 });
      return JSON.parse(result.stdout);
    };
    const { id } = await cmd('init', '--name', name, '--local-port', local, '--peer-port', peer,
      '--bind', testAddress, '--codex', runner,
      ...(useDefaultWorkspace ? [] : ['--workspace', workspace]),
      ...(description ? ['--description', description] : []),
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
  const a = await create('A', mock, undefined, '整理项目资料，负责发送进度通知。');
  const b = await create('B', mock, invite);
  const c = await create('C', process.env.LATTICE_TEST_CODEX || mock, undefined, undefined, true);
  assert.deepEqual(await readdir(b.env.LATTICE_HOME), ['settings.json']);
  const aDeclaration = await a.cmd('identity');
  assert.deepEqual(aDeclaration, {
    id: a.id, name: 'A', 'lattci-code': a.id, description: '整理项目资料，负责发送进度通知。',
  });
  const bSettingsPath = join(b.env.LATTICE_HOME, 'settings.json');
  const bSettings = JSON.parse(await readFile(bSettingsPath, 'utf8'));
  delete bSettings.description;
  await writeFile(bSettingsPath, JSON.stringify(bSettings));
  assert.equal((await b.cmd('identity')).description, null);
  const bDescription = '可审阅方案。\n负责汇总审核意见。';
  assert.equal((await b.cmd('profile', '--description', bDescription))['lattci-code'], b.id);

  const legacyDb = new DatabaseSync(join(c.env.LATTICE_HOME, 'lattice.sqlite'));
  legacyDb.exec(`CREATE TABLE peers (id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT,
    permission TEXT NOT NULL CHECK(permission IN ('none', 'full')))`);
  legacyDb.prepare("INSERT INTO peers (id, name, permission) VALUES (?, 'A', 'none')").run(a.id);
  legacyDb.close();

  await a.start();
  let bProcess = await b.start();
  await c.start();
  assert.equal((await c.cmd('status')).workspace, await realpath(join(c.env.LATTICE_HOME, 'workspace')));
  assert.equal((await c.cmd('status')).peers[0].description, null);
  await assert.rejects(a.cmd('pair', b.id, '--name', 'B', '--address', b.address), /请填写能力和职权描述/);
  await assert.rejects(a.cmd('pair', b.id, '--name', 'B', '--description', '  '), /请填写能力和职权描述/);
  await assert.rejects(a.cmd('pair', b.id, '--name', 'B', '--description', '字'.repeat(2001)), /1 至 2000 字符/);
  assert.deepEqual((await a.cmd('status')).peers, []);
  const pairB = await a.cmd('pair', b.id, '--name', 'B', '--description', bDescription, '--address', b.address);
  assert.deepEqual(pairB, { ...await b.cmd('identity'), permission: 'none' });
  await delay(300);
  assert.equal((await a.cmd('status')).peers[0].connected, false);
  await b.cmd('pair', a.id, '--name', 'A', '--description', aDeclaration.description);
  await c.cmd('pair', a.id, '--name', 'A', '--description', aDeclaration.description);
  await a.cmd('pair', c.id, '--name', 'C', '--description', '可协助整理资料。', '--address', c.address);
  await eventually(async () => (await a.cmd('status')).peers.every((peer) => peer.connected));
  await a.cmd('pair', b.id, '--name', 'B');
  assert.equal((await a.cmd('status')).peers.find((peer) => peer.id === b.id).address, b.address + '/lattice');
  assert.equal((await a.cmd('status')).peers.find((peer) => peer.id === b.id).description, bDescription);
  const wrongIdentity = 'f'.repeat(64);
  await a.cmd('pair', wrongIdentity, '--name', 'Wrong identity', '--description', '测试身份校验', '--address', b.address);
  await eventually(async () => (await a.cmd('status')).peers.find((peer) => peer.id === wrongIdentity)?.lastError === 'identity_mismatch');

  const client = new Client({ name: 'lattice-integration', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [runtime, 'mcp'], env: b.env });
  await client.connect(transport);
  clients.add(client);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(),
    ['inbox', 'message_status', 'reply', 'resend', 'send_message', 'status', 'update_description']);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const bStatus = await call('status');
  assert.equal(bStatus['lattci-code'], b.id);
  assert.equal(bStatus.description, bDescription);
  assert.equal(bStatus.peers[0].description, aDeclaration.description);
  const revisedDescription = '可审阅方案和测试记录。';
  assert.equal((await call('update_description', { description: revisedDescription })).description, revisedDescription);
  assert.equal((await b.cmd('identity')).description, revisedDescription);
  assert.equal((await call('status')).description, revisedDescription);
  assert.equal((await a.cmd('status')).peers.find((peer) => peer.id === b.id).description, bDescription);
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
  const refreshedA = await b.cmd('pair', a.id, '--name', 'A', '--description', '可整理项目和测试资料。');
  assert.equal(refreshedA.permission, 'full');
  const [automatic] = await a.cmd('send', 'request', '--to', b.id, '--body', 'automatic request');
  assert.equal((await eventually(async () => (await a.cmd('message', automatic.id)).replies[0])).body,
    'processed: automatic request');

  async function decideFileWrite(device, id, approve) {
    const settings = JSON.parse(await readFile(join(device.env.LATTICE_HOME, 'settings.json'), 'utf8'));
    const response = await fetch('http://127.0.0.1:' + settings.localPort, {
      method: 'POST', headers: { Authorization: 'Bearer ' + settings.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'file_review', args: { id, approve } }),
    });
    assert.equal(response.ok, true);
  }
  const outside = join(await realpath(base), 'outside');
  for (const approve of [false, true]) {
    const [request] = await a.cmd('send', 'request', '--to', b.id, '--body', 'approval: ' + outside);
    const review = await eventually(async () => (await b.cmd('reviews'))[0]);
    assert.deepEqual(review.paths, [outside]);
    assert.equal(review.messageId, request.id);
    assert.equal((await a.cmd('message', request.id)).replies.length, 0);
    await assert.rejects(b.cmd('review', review.id), /请在本机终端/);
    await decideFileWrite(b, review.id, approve);
    const reply = await eventually(async () => (await a.cmd('message', request.id)).replies[0]);
    assert.equal(reply.body, approve ? 'approved' : 'denied');
    assert.deepEqual(await b.cmd('reviews'), []);
  }

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
    await mkdir(outside);
    await writeFile(join(outside, 'readable.txt'), 'LATTICE_READ_OK');
    const [request] = await a.cmd('send', 'request', '--to', c.id, '--body', [
      'Run this controlled filesystem test using shell tools.',
      `First read ${outside}/readable.txt and verify LATTICE_READ_OK.`,
      'In your current working directory, create and verify inside.txt, then create and delete disposable.txt.',
      `Attempt a direct shell write of ${outside}/blocked.txt without extra permissions. It must fail.`,
      `Use request_permissions to request write access to this exact directory: ${outside}.`,
      `After approval, use the shell to write LATTICE_WRITE_OK to ${outside}/approved.txt.`,
      'If all steps succeeded, reply with exactly LATTICE_CODEX_OK.',
    ].join('\n'));
    const review = await eventually(async () => (await c.cmd('reviews'))[0], 65000);
    assert.deepEqual(review.paths, [outside]);
    await assert.rejects(readFile(join(outside, 'blocked.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(outside, 'approved.txt')), { code: 'ENOENT' });
    const defaultWorkspace = join(c.env.LATTICE_HOME, 'workspace');
    assert.ok((await readdir(defaultWorkspace)).includes('inside.txt'));
    await assert.rejects(readFile(join(defaultWorkspace, 'disposable.txt')), { code: 'ENOENT' });
    await decideFileWrite(c, review.id, true);
    const reply = await eventually(async () => (await a.cmd('message', request.id)).replies[0], 55000);
    assert.equal((await readFile(join(outside, 'approved.txt'), 'utf8')).trim(), 'LATTICE_WRITE_OK');
    assert.equal(reply.body.trim(), 'LATTICE_CODEX_OK');
    t.diagnostic('Real Codex CLI wrote and deleted inside the workspace, blocked external writes until approval, and returned its result over WSS');
  }
});

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}
