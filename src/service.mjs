import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function manageService(profile, action) {
  if (process.platform !== 'darwin') throw new Error('当前自动保活安装仅支持 macOS，请手动运行 serve');
  const label = 'local.lattice.' + profile.id.slice(0, 20);
  const domain = 'gui/' + process.getuid();
  const folder = join(homedir(), 'Library', 'LaunchAgents');
  const plist = join(folder, label + '.plist');
  const target = domain + '/' + label;
  const launchctl = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (action === 'status') {
    const status = launchctl('print', target);
    return { registered: status.status === 0, running: /state = running/.test(status.stdout || ''), label };
  }
  if (!['enable', 'disable'].includes(action)) throw new Error('请使用 service enable、disable 或 status');
  const registered = launchctl('print', target).status === 0;
  const unregister = () => {
    if (!registered) return;
    const stopped = launchctl('bootout', target);
    if (stopped.status !== 0) throw new Error(stopped.stderr.trim() || '无法停止晶格服务');
  };
  if (action === 'disable') {
    unregister();
    if (existsSync(plist)) unlinkSync(plist);
    return { enabled: false };
  }
  const source = resolve(process.argv[1]);
  if (!source.endsWith('.cjs')) throw new Error('请从已打包的 lattice.cjs 启用后台服务');
  const runtime = join(profile.directory, 'runtime.cjs');
  if (source !== runtime) {
    const staged = join(profile.directory, 'runtime-' + randomUUID() + '.tmp');
    try {
      copyFileSync(source, staged);
      renameSync(staged, runtime);
    } finally {
      rmSync(staged, { force: true });
    }
  }
  const definition = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[process.execPath, runtime, 'serve'].map((arg) => '<string>' + xml(arg) + '</string>').join('')}</array>
<key>EnvironmentVariables</key><dict><key>LATTICE_HOME</key><string>${xml(profile.directory)}</string></dict>
<key>RunAtLoad</key><true/>
<key>StandardErrorPath</key><string>${xml(join(profile.directory, 'service.log'))}</string>
</dict></plist>
`;
  if (registered && existsSync(plist) && readFileSync(plist, 'utf8') === definition) {
    const restarted = launchctl('kickstart', '-k', target);
    if (restarted.status !== 0) throw new Error(restarted.stderr.trim() || '无法重启晶格服务');
    return { enabled: true, label };
  }
  unregister();
  mkdirSync(folder, { recursive: true });
  writeFileSync(plist, definition, { mode: 0o600 });
  const started = launchctl('bootstrap', domain, plist);
  if (started.status !== 0) throw new Error(started.stderr.trim() || '无法注册晶格服务');
  return { enabled: true, label };
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
