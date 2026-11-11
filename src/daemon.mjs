import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { openStore } from './store.mjs';
import { peerUrl, validIdentity } from './profile.mjs';
import { maxBody, startTransport } from './transport.mjs';

const maxRequest = 96 * 1024;
const leaseDuration = 12000;
const allowedKinds = ['notice', 'request'];

export async function serve(profile) {
  const db = openStore(profile);
  const findPeer = db.prepare('SELECT * FROM peers WHERE id = ?');
  const findMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
  const update = db.prepare('UPDATE messages SET state = ? WHERE id = ?');
  const save = db.prepare(`INSERT INTO messages (id, peer, direction, kind, body, replyTo, createdAt, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const sessions = new Map();
  let activeChild;
  let stopping = false;
  let reminderInProgress = false;
  let remindAfter = 0;
  let connectedAgent = false;
  const transport = startTransport(profile, db, receive);

  function receive(message) {
    if (findMessage.get(message.id)) return;
    if (message.kind === 'reply') {
      const request = findMessage.get(message.replyTo);
      if (request?.direction !== 'out' || request.kind !== 'request' || request.peer !== message.from) {
        throw new Error('reply has no matching outgoing request');
      }
    }
    const peer = findPeer.get(message.from);
    const state = message.kind === 'request'
      ? (peer.permission === 'full' ? 'queued' : 'awaiting_approval')
      : 'received';
    save.run(message.id, message.from, 'in', message.kind, message.body, message.replyTo, message.createdAt, state);
    tick();
  }

  function finish(message, state, output) {
    update.run(state, message.id);
    sendMessage(message.peer, 'reply', boundedOutput(output), message.id);
  }

  function sendMessage(peer, kind, body, replyTo = null) {
    const message = { id: randomUUID(), kind, body, replyTo, createdAt: Date.now() };
    const state = transport.send(peer, message);
    save.run(message.id, peer, 'out', kind, body, replyTo, message.createdAt, state);
    return { peer, id: message.id, state };
  }

  function runRequest(message) {
    update.run('running', message.id);
    const child = spawn(profile.codex, [
      '--ask-for-approval', 'never', 'exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral',
      '--sandbox', profile.sandbox || 'read-only', '-C', profile.workspace, '-',
    ], { cwd: profile.workspace, stdio: ['pipe', 'pipe', 'ignore'] });
    activeChild = child;
    let output = '';
    let error;
    const timeout = setTimeout(() => {
      error = new Error('任务执行超时');
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, 600000);
    child.stdout.on('data', (data) => { output = (output + data.toString()).slice(-maxBody); });
    child.on('error', (cause) => { error = cause; });
    child.stdin.on('error', () => {});
    child.stdin.end(message.body);
    child.once('close', (code) => {
      clearTimeout(timeout);
      activeChild = undefined;
      if (stopping) return;
      if (error || code !== 0) {
        finish(message, 'failed', error ? 'Agent 执行失败：' + error.message : 'Agent 退出码：' + code);
      } else {
        finish(message, 'completed', output || '任务完成');
      }
      tick();
    });
  }

  function remind() {
    if (process.platform !== 'darwin' || reminderInProgress || Date.now() < remindAfter) return;
    const unseen = db.prepare("SELECT id FROM messages WHERE direction = 'in' AND seen = 0").all();
    if (!unseen.length) return;
    reminderInProgress = true;
    const script = 'display notification "' + unseen.length + ' 条消息可在 Codex 中查看" with title "晶格 Lattice"';
    const notifier = spawn('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' });
    notifier.on('error', () => {});
    notifier.once('close', (code) => {
      reminderInProgress = false;
      if (stopping) return;
      if (code !== 0) {
        remindAfter = Date.now() + 30000;
        return;
      }
      const mark = db.prepare('UPDATE messages SET seen = 1 WHERE id = ?');
      for (const row of unseen) mark.run(row.id);
    });
  }

  function tick() {
    if (stopping) return;
    for (const [session, last] of sessions) {
      if (Date.now() - last > leaseDuration) sessions.delete(session);
    }
    connectedAgent = sessions.size > 0;
    if (!connectedAgent) return;
    remind();
    if (activeChild || !profile.workspace) return;
    const message = db.prepare(`SELECT * FROM messages WHERE direction = 'in' AND kind = 'request'
      AND state IN ('queued', 'approved') ORDER BY createdAt, rowid LIMIT 1`).get();
    if (!message) return;
    if (message.state === 'queued' && findPeer.get(message.peer)?.permission !== 'full') {
      update.run('awaiting_approval', message.id);
      return;
    }
    runRequest(message);
  }

  const handlers = {
    status: () => ({
      id: profile.id, name: profile.name, agentOnline: connectedAgent,
      executionEnabled: Boolean(profile.workspace), peerPort: profile.peerPort, bind: profile.bind,
      peers: db.prepare('SELECT id, name, address, permission FROM peers ORDER BY name').all()
        .map((peer) => ({ ...peer, ...transport.status(peer.id) })),
    }),
    pair: ({ id, name, address }) => {
      if (!validIdentity(id) || id === profile.id || typeof name !== 'string' || !name.trim() || name.length > 80) {
        throw new Error('对端名称或 256 位身份码无效');
      }
      db.prepare(`INSERT INTO peers (id, name, address, permission) VALUES (?, ?, ?, 'none')
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, address = excluded.address`)
        .run(id, name, peerUrl(address));
      transport.connect(findPeer.get(id));
      return { id, permission: findPeer.get(id).permission };
    },
    permission: ({ id, level }) => {
      if (!['none', 'full'].includes(level) || !findPeer.get(id ?? '')) throw new Error('发送方或权限无效');
      db.prepare('UPDATE peers SET permission = ? WHERE id = ?').run(level, id);
      if (level === 'none') {
        db.prepare("UPDATE messages SET state = 'awaiting_approval' WHERE peer = ? AND direction = 'in' AND state = 'queued'").run(id);
      }
      return { id, level };
    },
    send: ({ peers, kind, body }) => {
      if (!Array.isArray(peers) || !peers.length || peers.length > 50 ||
          !peers.every((id) => validIdentity(id) && findPeer.get(id)) || !allowedKinds.includes(kind) ||
          typeof body !== 'string' || !body.trim() || Buffer.byteLength(body) > maxBody) {
        throw new Error('请指定已配对的设备、消息类型及正文（最多 16000 字节）');
      }
      return [...new Set(peers)].map((peer) => sendMessage(peer, kind, body));
    },
    resend: ({ id }) => {
      const row = findMessage.get(id ?? '');
      if (row?.direction !== 'out' || !findPeer.get(row.peer)) throw new Error('仅可重发已有的发出消息');
      const { kind, body, replyTo, createdAt } = row;
      const state = transport.send(row.peer, { id, kind, body, replyTo, createdAt });
      update.run(state, id);
      return { id, peer: row.peer, state };
    },
    inbox: () => db.prepare("SELECT * FROM messages WHERE direction = 'in' ORDER BY rowid DESC LIMIT 100").all(),
    message: ({ id }) => {
      const message = findMessage.get(id ?? '');
      if (!message) throw new Error('消息不存在');
      const replies = db.prepare("SELECT * FROM messages WHERE replyTo = ? ORDER BY rowid").all(id);
      return { message, replies };
    },
    decision: ({ id, approve }) => {
      const message = findMessage.get(id ?? '');
      if (typeof approve !== 'boolean' || message?.state !== 'awaiting_approval') throw new Error('请求不在待授权状态');
      if (approve) update.run('approved', id);
      else finish(message, 'rejected', '接收方拒绝了此请求');
      tick();
      return findMessage.get(id);
    },
    reply: ({ id, body }) => {
      const message = findMessage.get(id ?? '');
      if (message?.direction !== 'in' || message.kind !== 'request' ||
          !['queued', 'approved'].includes(message.state) ||
          typeof body !== 'string' || !body.trim() || Buffer.byteLength(body) > maxBody) {
        throw new Error('仅可回复已获授权且未执行的请求');
      }
      finish(message, 'completed', body);
      return { id, state: 'completed', reply: db.prepare("SELECT id, state FROM messages WHERE direction = 'out' AND replyTo = ? ORDER BY rowid DESC LIMIT 1").get(id) };
    },
    presence: ({ id, active }) => {
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || typeof active !== 'boolean') throw new Error('无效会话');
      if (active) sessions.set(id, Date.now());
      else sessions.delete(id);
      tick();
      return { online: connectedAgent };
    },
  };

  const control = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const token = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + profile.token);
    if (request.method !== 'POST' || token.length !== expected.length || !timingSafeEqual(token, expected)) {
      response.writeHead(403).end(JSON.stringify({ error: '拒绝访问' }));
      return;
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxRequest) throw new Error('请求太大');
        chunks.push(chunk);
      }
      const { action, args = {} } = JSON.parse(Buffer.concat(chunks).toString());
      if (!Object.hasOwn(handlers, action)) throw new Error('未知操作');
      response.end(JSON.stringify({ result: handlers[action](args) }));
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: error.message }));
    }
  });
  control.requestTimeout = 5000;
  control.headersTimeout = 5000;

  const interval = setInterval(tick, 2000);
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    activeChild?.kill('SIGTERM');
    await Promise.all([transport.stop(), new Promise((resolve) => {
      control.close(resolve);
      control.closeAllConnections();
    })]);
    db.close();
  }

  try {
    await listen(control, profile.localPort, '127.0.0.1');
    await listen(transport.server, profile.peerPort, profile.bind);
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function boundedOutput(output) {
  const buffer = Buffer.from(output);
  let start = Math.max(0, buffer.length - maxBody);
  while ((buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString();
}
