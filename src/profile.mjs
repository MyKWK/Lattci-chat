import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const profilePath = () => resolve(process.env.LATTICE_HOME || join(homedir(), '.lattice'));
export function identityCode(certificate) {
  const publicKey = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(publicKey).digest('hex');
}
export const validIdentity = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function deviceDeclaration({ id, name, description }) {
  return { id, name, 'lattci-code': id, description: description ?? null };
}

export function validateDescription(value) {
  const description = typeof value === 'string' ? value.trim() : '';
  if (!description || [...description].length > 2000) {
    throw new Error('请填写能力和职权描述（1 至 2000 字符）');
  }
  return description;
}

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
  const description = options.description === undefined ? null : validateDescription(options.description);
  if (options.codex && !isAbsolute(options.codex)) {
    throw new Error('请用 --codex 指定可执行文件的绝对路径');
  }
  const identitySource = options['identity-source'] ? resolve(options['identity-source']) : null;
  let identityId;
  if (identitySource) {
    identityId = embeddedIdentity(identitySource).id;
  } else {
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
  }
  writeFileSync(settings, JSON.stringify({
    localPort, peerPort, bind, name, description, token: randomBytes(32).toString('hex'),
    identitySource, identityId,
    codex: options.codex || null,
    workspace: options.workspace ? resolve(options.workspace) : join(directory, 'workspace'),
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return readProfile(directory);
}

export function readSettings(directory) {
  return JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'));
}

export function updateDescription(profile, value) {
  const description = validateDescription(value);
  const { directory } = profile;
  const settings = readSettings(directory);
  const temporary = join(directory, 'settings.' + randomBytes(12).toString('hex') + '.tmp');
  try {
    writeFileSync(temporary, JSON.stringify({ ...settings, description }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(directory, 'settings.json'));
  } finally {
    rmSync(temporary, { force: true });
  }
  return deviceDeclaration({ ...profile, description });
}

export function readProfile(directory) {
  const settings = readSettings(directory);
  const workspace = settings.workspace || join(directory, 'workspace');
  const profile = { ...settings, directory, workspace };
  if (settings.identitySource) {
    const identity = embeddedIdentity(settings.identitySource);
    if (identity.id !== settings.identityId) throw new Error('联机脚本中的设备身份已变更');
    return { ...profile, ...identity };
  }
  const key = readFileSync(join(directory, 'identity.key'));
  const cert = readFileSync(join(directory, 'identity.crt'));
  return { ...profile, key, cert, id: identityCode(cert) };
}

function embeddedIdentity(path) {
  try {
    const marker = 'const invitationIdentity = ';
    const line = readFileSync(path, 'utf8').split(/\r?\n/).find((entry) => entry.startsWith(marker));
    if (!line?.endsWith(';')) throw new Error();
    const { key, cert } = JSON.parse(line.slice(marker.length, -1));
    if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))) throw new Error();
    return { key, cert, id: identityCode(cert) };
  } catch {
    throw new Error('无法从联机脚本读取设备身份，请确认原文件仍在首次运行的位置');
  }
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
