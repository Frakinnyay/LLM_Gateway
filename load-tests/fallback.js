// Benchmark 4 — provider failure and recovery (zero-cost with mock providers).
//   k6 run -e API_KEY=lgw_... -e ADMIN_TOKEN=... load-tests/fallback.js
// FAULT=http_503 (default; breaker opens after repeated failures) | disable (operator disables the primary)
// PRIMARY=mock (provider to break). Requires >= 2 providers serving MODEL (MOCK_PROVIDER_INSTANCES=2 does this).
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { ADMIN_TOKEN, API_KEY, GATEWAY_URL, chatBody, jsonHeaders, requireEnv, stamp } from './common.js';

const PRIMARY = __ENV.PRIMARY || 'mock';
const FAULT = __ENV.FAULT || 'http_503';
const FIRST_N = Number(__ENV.FIRST_N || 10);
const admin = { headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' } };

const attempted = new Counter('attempted'), viaFallback = new Counter('served_via_fallback'), viaPrimary = new Counter('served_via_primary'), failed = new Counter('failed_requests');
const latencyEarly = new Trend('latency_first_requests', true), latencyLater = new Trend('latency_after_breaker', true);

export const options = {
  scenarios: { load: { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 20), timeUnit: '1s', duration: __ENV.DURATION || '30s', preAllocatedVUs: 30, maxVUs: 100 } },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

function inject() {
  return FAULT === 'disable'
    ? http.post(`${GATEWAY_URL}/api/providers/${PRIMARY}/disable`, null, admin)
    : http.post(`${GATEWAY_URL}/api/providers/${PRIMARY}/failure-mode`, JSON.stringify({ mode: FAULT }), admin);
}
function heal() {
  return FAULT === 'disable'
    ? http.post(`${GATEWAY_URL}/api/providers/${PRIMARY}/enable`, null, admin)
    : http.post(`${GATEWAY_URL}/api/providers/${PRIMARY}/failure-mode`, JSON.stringify({ mode: 'none' }), admin);
}

export function setup() {
  requireEnv('API_KEY', API_KEY); requireEnv('ADMIN_TOKEN', ADMIN_TOKEN);
  const r = inject();
  if (r.status !== 200) throw new Error(`could not inject fault (${r.status}): ${r.body}`);
  return { injectedAt: Date.now() };
}

export default function () {
  attempted.add(1);
  const res = http.post(`${GATEWAY_URL}/v1/chat/completions`, chatBody(`fallback test ${__VU}-${__ITER}-${Date.now()}`), jsonHeaders(API_KEY, { 'Cache-Control': 'no-cache' }));
  if (res.status !== 200) { failed.add(1); return; }
  if (res.headers['X-Fallback-Used'] === 'true') viaFallback.add(1); else viaPrimary.add(1);
  (__ITER < FIRST_N ? latencyEarly : latencyLater).add(res.timings.duration);
}

export function teardown() {
  heal();
  // Recovery time: how long until the primary serves traffic again once healed (includes breaker cooldown for http_503).
  const start = Date.now();
  for (let i = 0; i < 120; i++) {
    const r = http.post(`${GATEWAY_URL}/v1/chat/completions`, chatBody(`recovery probe ${i}-${Date.now()}`), jsonHeaders(API_KEY, { 'Cache-Control': 'no-cache' }));
    if (r.status === 200 && r.headers['X-Provider'] === PRIMARY) { console.log(`RECOVERY_SECONDS ${((Date.now() - start) / 1000).toFixed(2)}`); return; }
    sleep(0.5);
  }
  console.log('RECOVERY_SECONDS not observed within 60 s');
}

export function handleSummary(data) {
  const c = (n) => (data.metrics[n] ? data.metrics[n].values.count : 0);
  const t = (n) => (data.metrics[n] ? data.metrics[n].values : null);
  const attemptedN = c('attempted');
  const summary = {
    fault: FAULT, primary: PRIMARY, requests_attempted: attemptedN, served_via_fallback: c('served_via_fallback'),
    served_via_primary: c('served_via_primary'), failed: c('failed_requests'),
    recovery_rate_via_fallback: attemptedN === 0 ? null : c('served_via_fallback') / attemptedN,
    latency_first_requests_ms: t('latency_first_requests'), latency_after_breaker_ms: t('latency_after_breaker'),
    note: 'Recovery time after healing is printed by teardown as RECOVERY_SECONDS.',
  };
  return { stdout: JSON.stringify(summary, null, 2) + '\n', [`load-tests/results/fallback-${stamp()}.json`]: JSON.stringify(summary, null, 2) };
}
