// Shared helpers for the k6 scripts. Configure with `-e NAME=value`.
export const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://localhost:8080';
export const API_KEY = __ENV.API_KEY || '';
export const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || '';
export const MODEL = __ENV.MODEL || 'mock-model';

export function chatBody(content, extra) {
  return JSON.stringify(Object.assign({ model: MODEL, messages: [{ role: 'user', content }] }, extra || {}));
}
export function jsonHeaders(key, extra) {
  return { headers: Object.assign({ 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, extra || {}) };
}
export function requireEnv(name, value) {
  if (!value) throw new Error(`${name} is required (-e ${name}=...)`);
}
export function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
export function pct(values, key) { return values && values[key] !== undefined ? Number(values[key].toFixed(2)) : null; }
