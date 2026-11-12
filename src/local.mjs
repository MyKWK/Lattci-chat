import { profilePath, readSettings } from './profile.mjs';

export async function callLocal(action, args = {}) {
  let settings;
  try {
    settings = readSettings(profilePath());
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('晶格尚未初始化，请先运行 lattice.cjs init');
    throw error;
  }
  let response;
  try {
    response = await fetch('http://127.0.0.1:' + settings.localPort, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, args }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error('本地晶格服务不可达，请检查 lattice.cjs serve 或 service enable');
  }
  const body = await response.json();
  if (body.error === '未知操作') throw new Error('后台服务不支持此操作，请更新晶格后台程序');
  if (!response.ok || body.error) throw new Error(body.error || '本地晶格服务返回错误');
  return body.result;
}
