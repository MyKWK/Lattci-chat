import { createServer } from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';
import { identityCode } from './profile.mjs';

const maxPayload = 64 * 1024;
export const maxBody = 16000;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function startTransport(profile, db, onMessage) {
  const options = { key: profile.key, cert: profile.cert, minVersion: 'TLSv1.2' };
  // Pairing pins the peer's public key. TLS proves possession of the corresponding private key.
  const server = createServer({ ...options, requestCert: true, rejectUnauthorized: false });
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const connections = new Map();
  const dialing = new Map();
  const failures = new Map();
  const findPeer = db.prepare('SELECT * FROM peers WHERE id = ?');

  function attach(peerId, socket, tlsSocket, outbound) {
    socket.on('error', () => socket.terminate());
    const old = connections.get(peerId);
    const preferOutbound = profile.id < peerId;
    if (old && (old.outbound === preferOutbound || outbound !== preferOutbound)) {
      socket.close(1000, 'duplicate connection');
      return;
    }
    const link = { socket, outbound, alive: true, remoteIp: tlsSocket.remoteAddress };
    connections.set(peerId, link);
    failures.delete(peerId);
    old?.socket.close(1000, 'duplicate connection');
    socket.on('pong', () => { link.alive = true; });
    socket.on('close', () => {
      if (connections.get(peerId) === link) connections.delete(peerId);
    });
    socket.on('message', (raw, binary) => {
      try {
        if (binary || !findPeer.get(peerId)) throw new Error('invalid sender');
        const message = JSON.parse(raw.toString());
        if (!message || !uuid.test(message.id ?? '') ||
            !['notice', 'request', 'reply'].includes(message.kind) ||
            typeof message.body !== 'string' || !message.body.length || Buffer.byteLength(message.body) > maxBody ||
            (message.kind === 'reply' ? !uuid.test(message.replyTo ?? '') : message.replyTo !== null) ||
            !Number.isSafeInteger(message.createdAt)) throw new Error('invalid message');
        onMessage({ ...message, from: peerId });
      } catch (error) {
        console.error('Lattice peer message:', error.message);
        socket.close(1008, 'message rejected');
      }
    });
  }

  server.on('request', (_request, response) => response.writeHead(404).end());
  server.on('upgrade', (request, socket, head) => {
    try {
      const certificate = socket.getPeerCertificate().raw;
      const peerId = certificate && identityCode(certificate);
      if (request.url !== '/lattice' || !peerId || !findPeer.get(peerId)) return socket.destroy();
      wss.handleUpgrade(request, socket, head, (ws) => attach(peerId, ws, socket, false));
    } catch {
      socket.destroy();
    }
  });

  function connect(peer) {
    if (!peer.address || connections.has(peer.id) || dialing.has(peer.id)) return;
    const socket = new WebSocket(peer.address, {
      ...options, rejectUnauthorized: false, followRedirects: false,
      maxPayload, handshakeTimeout: 5000,
    });
    dialing.set(peer.id, socket);
    let authenticatedSocket;
    socket.on('upgrade', (response) => {
      const certificate = response.socket.getPeerCertificate().raw;
      if (certificate && identityCode(certificate) === peer.id && findPeer.get(peer.id)?.address === peer.address) {
        authenticatedSocket = response.socket;
      }
    });
    socket.on('open', () => {
      dialing.delete(peer.id);
      if (authenticatedSocket) attach(peer.id, socket, authenticatedSocket, true);
      else {
        failures.set(peer.id, 'identity_mismatch');
        socket.terminate();
      }
    });
    socket.on('error', (error) => {
      if (!connections.has(peer.id)) failures.set(peer.id, error.code || error.message);
      socket.terminate();
    });
    socket.on('close', () => {
      if (dialing.get(peer.id) === socket) dialing.delete(peer.id);
    });
  }

  const reconnect = setInterval(() => {
    for (const peer of db.prepare('SELECT * FROM peers WHERE address IS NOT NULL').all()) connect(peer);
  }, 3000);
  const keepAlive = setInterval(() => {
    for (const link of connections.values()) {
      if (!link.alive) {
        link.socket.terminate();
        continue;
      }
      link.alive = false;
      link.socket.ping();
    }
  }, 20000);

  return {
    server, connect,
    send(peerId, message) {
      const link = connections.get(peerId);
      if (link?.socket.readyState !== WebSocket.OPEN) return 'send_failed';
      link.socket.send(JSON.stringify(message));
      return 'sent';
    },
    status(peerId) {
      const link = connections.get(peerId);
      return link
        ? { connected: true, remoteIp: link.remoteIp }
        : { connected: false, lastError: failures.get(peerId) ?? null };
    },
    stop() {
      clearInterval(reconnect);
      clearInterval(keepAlive);
      for (const socket of dialing.values()) socket.terminate();
      for (const link of connections.values()) link.socket.terminate();
      wss.close();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
