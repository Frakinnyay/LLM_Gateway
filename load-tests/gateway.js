// Benchmark 2 — gateway overhead. Run twice against the SAME upstream and compare percentiles:
//   k6 run -e TARGET=direct  -e UPSTREAM_URL=http://localhost:9099/v1 -e UPSTREAM_KEY=dummy -e MODEL=llama-3.3-70b-versatile load-tests/gateway.js
//   k6 run -e TARGET=gateway -e API_KEY=lgw_... -e MODEL=llama-3.3-70b-versatile load-tests/gateway.js
// Gateway requests send Cache-Control: no-cache so they measure the uncached path (rate limit, budget, auth, provider call, logging).
import http from 'k6/http';
import { check } from 'k6';
import { API_KEY, GATEWAY_URL, MODEL, chatBody, jsonHeaders, pct, requireEnv, stamp } from './common.js';

const TARGET = __ENV.TARGET || 'gateway';
const URL = TARGET === 'direct' ? `${__ENV.UPSTREAM_URL || ''}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
const KEY = TARGET === 'direct' ? (__ENV.UPSTREAM_KEY || 'dummy') : API_KEY;

export const options = {
  scenarios: {
    load: {
      executor: 'constant-arrival-rate', // open model: fixed arrival rate, avoids coordinated omission
      rate: Number(__ENV.RATE || 20), timeUnit: '1s', duration: __ENV.DURATION || '60s',
      preAllocatedVUs: Number(__ENV.VUS || 50), maxVUs: Number(__ENV.MAX_VUS || 200),
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: { http_req_failed: ['rate<0.01'] }, // adjust to taste; a failing threshold makes k6 exit non-zero
};

export function setup() {
  if (TARGET === 'gateway') requireEnv('API_KEY', API_KEY); else requireEnv('UPSTREAM_URL', __ENV.UPSTREAM_URL);
}

export default function () {
  const extra = TARGET === 'gateway' ? { 'Cache-Control': 'no-cache' } : {};
  const res = http.post(URL, chatBody(`load test prompt ${__VU}-${__ITER}-${Date.now()}`), jsonHeaders(KEY, extra));
  check(res, { 'status is 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  const d = data.metrics.http_req_duration.values;
  const summary = {
    target: TARGET, model: MODEL, rate_target_rps: Number(__ENV.RATE || 20), duration: __ENV.DURATION || '60s',
    requests: data.metrics.http_reqs.values.count, achieved_rps: pct(data.metrics.http_reqs.values, 'rate'),
    error_rate: data.metrics.http_req_failed ? data.metrics.http_req_failed.values.rate : null,
    latency_ms: { avg: pct(d, 'avg'), p50: pct(d, 'med'), p90: pct(d, 'p(90)'), p95: pct(d, 'p(95)'), p99: pct(d, 'p(99)'), max: pct(d, 'max') },
  };
  return { stdout: JSON.stringify(summary, null, 2) + '\n', [`load-tests/results/gateway-${TARGET}-${stamp()}.json`]: JSON.stringify(summary, null, 2) };
}
