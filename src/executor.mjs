import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const approvalPolicy = { granular: {
  request_permissions: true, sandbox_approval: false, rules: false, mcp_elicitations: false,
} };

export function prepareExecutor(profile) {
  mkdirSync(profile.workspace, { recursive: true, mode: 0o700 });
  const workspace = realpathSync(profile.workspace);
  const applications = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const installed = process.platform === 'darwin' && existsSync(applications) ? applications : 'codex';
  const codex = profile.codex && profile.codex !== 'codex' ? profile.codex : installed;
  const protectedFiles = [
    ...['settings.json', 'identity.key', 'lattice.sqlite', 'lattice.sqlite-wal', 'lattice.sqlite-shm', 'runtime.cjs']
      .map((name) => join(profile.directory, name)),
    profile.identitySource,
    join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'),
  ].filter(Boolean);
  return { workspace, codex, protectedFiles };
}

export function executeRequest(executor, body, requestApproval) {
  const { codex, workspace, protectedFiles } = executor;
  const child = spawn(codex, ['app-server', '--disable', 'plugins', '--disable', 'apps', '--disable', 'hooks',
    '--enable', 'skip_host_skill_discovery', '--enable', 'request_permissions_tool'], {
    cwd: workspace, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  const permissionId = 'lattci-' + randomUUID();
  let nextId = 0;
  let output = '';
  let settleTurn;
  let closed;
  const turn = new Promise((resolve) => { settleTurn = resolve; });
  const lines = createInterface({ input: child.stdout });

  function stop(message) {
    if (closed) return;
    closed = new Error(message);
    for (const { reject } of pending.values()) reject(closed);
    pending.clear();
    settleTurn({ state: 'failed', output: message });
    lines.close();
    child.kill();
  }

  function send(message) {
    if (!closed) child.stdin.write(JSON.stringify(message) + '\n');
  }

  function call(method, params) {
    if (closed) return Promise.reject(closed);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  }

  child.on('error', () => stop('无法启动本机 Codex。请安装或更新 Codex CLI。'));
  child.stdin.on('error', () => stop('本机 Codex 已停止接收请求'));
  child.on('close', () => stop('本机 Codex 提前退出'));
  lines.on('line', (line) => {
    try {
      const { id, method, params, result, error } = JSON.parse(line);
      if (id !== undefined && method) {
        if (method !== 'item/permissions/requestApproval') {
          send({ id, error: { code: -32601, message: 'Only scoped filesystem approvals are supported' } });
          return;
        }
        const paths = requestedPaths(params.permissions);
        const respond = (approved) => send({ id, result: {
          permissions: approved ? { fileSystem: { write: paths } } : {}, scope: 'turn',
        } });
        if (paths.length) requestApproval(paths, params.reason, respond);
        else respond(false);
      } else if (id !== undefined && pending.has(id)) {
        const { resolve, reject } = pending.get(id);
        pending.delete(id);
        if (error) reject(new Error('Codex 未接受晶格的执行配置或任务'));
        else resolve(result);
      } else if (method === 'item/completed' && params.item.type === 'agentMessage') {
        output = params.item.text;
      } else if (method === 'turn/completed') {
        settleTurn(params.turn.status === 'completed'
          ? { state: 'completed', output: output || '任务完成' }
          : { state: 'failed', output: '本机 Codex 未完成任务' });
      }
    } catch {
      stop('本机 Codex 返回了无效的执行响应');
    }
  });

  const timeout = setTimeout(() => stop('任务或审批等待超时'), 600000);
  const result = (async () => {
    try {
      await call('initialize', { clientInfo: { name: 'lattci-chat', version: '1' }, capabilities: { experimentalApi: true } });
      send({ method: 'initialized' });
      const { config } = await call('config/read', { cwd: workspace, includeLayers: false });
      const mcpServers = Object.fromEntries(Object.keys(config.mcp_servers || {}).map((name) => [name, { enabled: false }]));
      const filesystem = Object.fromEntries([[':root', 'read'], [workspace, 'write'],
        ...protectedFiles.map((path) => [path, 'deny'])]);
      const started = await call('thread/start', {
        cwd: workspace, runtimeWorkspaceRoots: [workspace], ephemeral: true,
        approvalPolicy, approvalsReviewer: 'user', permissions: permissionId,
        config: {
          permissions: { [permissionId]: { filesystem, network: { enabled: false } } },
          mcp_servers: mcpServers, shell_environment_policy: { inherit: 'none' }, web_search: 'disabled',
        },
        developerInstructions: 'Use the dedicated workspace for all writes by default. For any necessary write or deletion outside it, use request_permissions to request write access to the narrowest absolute path and state the intended change. Wait for the local owner’s decision. Do not work around a refusal.',
      });
      const applied = started.approvalPolicy?.granular;
      if (started.activePermissionProfile?.id !== permissionId || started.approvalsReviewer !== 'user' ||
          applied?.request_permissions !== true || applied.sandbox_approval || applied.rules || applied.mcp_elicitations) {
        throw new Error('本机 Codex 未采用晶格的目录权限和人工审批规则');
      }
      let cursor;
      do {
        const inventory = await call('mcpServerStatus/list', { threadId: started.thread.id, cursor, limit: 100 });
        if (inventory.data.some((server) => Object.keys(server.tools || {}).length || server.resources?.length || server.resourceTemplates?.length)) {
          throw new Error('本机 Codex 为晶格任务加载了额外的 MCP 能力');
        }
        cursor = inventory.nextCursor;
      } while (cursor);
      await call('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: body, textElements: [] }] });
      return await turn;
    } catch (error) {
      return { state: 'failed', output: error.message };
    } finally {
      clearTimeout(timeout);
      stop('本机任务已结束');
    }
  })();

  return { result, stop: () => stop('晶格后台已停止') };
}

function requestedPaths({ fileSystem } = {}) {
  const paths = fileSystem?.entries?.length
    ? fileSystem.entries.filter(({ access, path }) => access === 'write' && path.type === 'path').map(({ path }) => path.path)
    : fileSystem?.write || [];
  return [...new Set(paths.filter((path) => typeof path === 'string' && isAbsolute(path)))];
}
