import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const profilePath = () => resolve(process.env.LATTICE_HOME || join(homedir(), '.lattice'));
export function identityCode(certificate) {
  const publicKey = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(publicKey).digest('hex');
}
export const validIdentity = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function initProfile(directory, options) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && (statSync(directory).mode & 0o077) !== 0) {
    throw new Error('请使用仅自己可访问的晶格数据目录');
  }
  const settings = join(directory, 'settings.json');
  if (existsSync(settings)) throw new Error('晶格已经初始化');
  const localPort = port(options['local-port'] || 48451);
  const peerPort = port(options['peer-port'] || 48452);
  if (localPort === peerPort) throw new Error('本机控制端口与对端端口必须不同');
  const bind = options.bind || '127.0.0.1';
  const name = options.name || 'Lattice';
  if (name.length > 80) throw new Error('名称最多 80 字符');
  if (options.workspace && !isAbsolute(options.codex || '')) {
    throw new Error('启用自动执行时请用 --codex 指定可执行文件的绝对路径');
  }
  const keyPath = join(directory, 'identity.key');
  const certPath = join(directory, 'identity.crt');
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const created = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '3650',
      '-subj', '/CN=Lattice', '-keyout', keyPath, '-out', certPath,
    ], { encoding: 'utf8' });
    if (created.error || created.status !== 0) throw new Error('需要可用的 OpenSSL 生成设备身份');
  }
  chmodSync(keyPath, 0o600);
  writeFileSync(settings, JSON.stringify({
    localPort, peerPort, bind, name, token: randomBytes(32).toString('hex'),
    codex: options.codex || 'codex',
    workspace: options.workspace ? resolve(options.workspace) : null,
    sandbox: options['workspace-write'] ? 'workspace-write' : 'read-only',
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return readProfile(directory);
}

export function readProfile(directory) {
  const settings = JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'));
  const key = readFileSync(join(directory, 'identity.key'));
  const cert = readFileSync(join(directory, 'identity.crt'));
  return { ...settings, directory, key, cert, id: identityCode(cert) };
}

function port(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) throw new Error('端口应在 1024 到 65535 之间');
  return parsed;
}

export function peerUrl(address) {
  if (!address) return null;
  const url = new URL(address);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash ||
      !['/', '/lattice'].includes(url.pathname)) {
    throw new Error('对端地址应为 wss://主机:端口');
  }
  url.pathname = '/lattice';
  return url.href;
}
