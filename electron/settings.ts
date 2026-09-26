import type { SettingsInput } from '../src/types.js';
export function validateSettings(input: SettingsInput): SettingsInput {
  if (!input || typeof input.url !== 'string') throw new Error('请输入有效的网关地址。');
  let url: URL;
  try { url = new URL(input.url.trim()); } catch { throw new Error('网关地址格式不正确。'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('第一版仅支持本机回环网关地址，例如 ws://127.0.0.1:18789。');
  }
  const distro = typeof input.distro === 'string' ? input.distro.trim() : '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(distro)) throw new Error('WSL 发行版名称不正确。');
  for (const key of ['token', 'password'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 16384)) throw new Error('连接凭据格式或长度不正确。');
  }
  return {url:url.href, distro, token:input.token?.trim(), password:input.password};
}
export function validateSessionKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\x00-\x1f]/.test(value)) throw new Error('会话标识不正确。');
  return value;
}
