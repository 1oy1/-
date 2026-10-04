import { staticApi, isStaticMode } from './static-api.js?v=4';

export async function api(url, options = {}) {
  if (isStaticMode()) return staticApi(url, options);
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

export { isStaticMode };
