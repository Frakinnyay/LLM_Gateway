// Benchmarks 1 and 3 — cache hit rates and cost with/without cache.
//   node scripts/gen-cache-dataset.js 500 1 > load-tests/data/cache_workload.json
//   k6 run -e API_KEY=lgw_... -e ADMIN_TOKEN=... load-tests/cache.js
// Runs ONE virtual user sequentially so repeats/paraphrases always follow their originals.
// Use a FRESH tenant (new API key) and flush Redis/semantic cache between runs, otherwise earlier runs inflate hit rates.
import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';
import { ADMIN_TOKEN, API_KEY, GATEWAY_URL, chatBody, jsonHeaders, requireEnv, stamp } from './common.js';

// NOTE: k6 resolves open() paths relative to this script's directory (UNVERIFIED on your k6 version; override with -e DATASET=...).
const workload = new SharedArray('workload', () => JSON.parse(open(__ENV.DATASET || './data/cache_workload.json')));
const KINDS = ['new', 'exact_repeat', 'paraphrase'];
const total = {}, hits = {};
KINDS.forEach((k) => { total[k] = new Counter(`kind_${k}_requests`); hits[k] = new Counter(`kind_${k}_hits`); });
const exactHits = new Counter('cache_exact_hits'), semanticHits = new Counter('cache_semantic_hits'), misses = new Counter('cache_misses'), failed = new Counter('failed_requests');

export const options = {
  scenarios: { workload: { executor: 'shared-iterations', vus: 1, iterations: workload.length, maxDuration: __ENV.MAX_DURATION || '30m' } },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)'],
};

export function setup() { requireEnv('API_KEY', API_KEY); }

export default function () {
  const item = workload[__ITER];
  const res = http.post(`${GATEWAY_URL}/v1/chat/completions`, chatBody(item.prompt), jsonHeaders(API_KEY));
  if (res.status !== 200) { failed.add(1); return; }
  total[item.kind].add(1);
  const cache = res.headers['X-Cache'], type = res.headers['X-Cache-Type'];
  if (cache === 'HIT' && type === 'exact') { exactHits.add(1); hits[item.kind].add(1); }
  else if (cache === 'HIT' && type === 'semantic') { semanticHits.add(1); hits[item.kind].add(1); }
  else misses.add(1);
}

export function teardown() {
  if (!ADMIN_TOKEN) return console.log('ADMIN_TOKEN not set: skipping cost/savings readout');
  sleep(3); // request logs are written asynchronously (flush interval ~1 s)
  const stats = http.get(`${GATEWAY_URL}/api/cache/stats?hours=1`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  console.log('GATEWAY_CACHE_STATS ' + stats.body);
}

export function handleSummary(data) {
  const c = (n) => (data.metrics[n] ? data.metrics[n].values.count : 0);
  const e = c('cache_exact_hits'), s = c('cache_semantic_hits'), m = c('cache_misses');
  const served = e + s + m;
  const rate = (x) => (served === 0 ? null : x / served);
  const byKind = {};
  KINDS.forEach((k) => { const t = c(`kind_${k}_requests`); byKind[k] = { requests: t, hits: c(`kind_${k}_hits`), hit_rate: t === 0 ? null : c(`kind_${k}_hits`) / t }; });
  const summary = {
    dataset_size: workload.length, served, failed: c('failed_requests'),
    exact_hit_rate: rate(e), semantic_hit_rate: rate(s), overall_hit_rate: rate(e + s), by_kind: byKind,
    note: 'Rates describe THIS synthetic workload and the configured embedder/threshold only. Cost savings: see GATEWAY_CACHE_STATS (estimated_savings_usd) printed by teardown; they depend on config/pricing.json.',
  };
  return { stdout: JSON.stringify(summary, null, 2) + '\n', [`load-tests/results/cache-${stamp()}.json`]: JSON.stringify(summary, null, 2) };
}
