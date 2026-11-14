#!/usr/bin/env node
/**
 * Generates a SYNTHETIC, seeded, ordered prompt workload for the cache benchmark.
 *   node scripts/gen-cache-dataset.js [total=500] [seed=1] > load-tests/data/cache_workload.json
 * kinds: "new" (first time seen), "exact_repeat" (identical to an earlier prompt), "paraphrase" (reworded earlier prompt).
 * Repeats/paraphrases always come AFTER their original. The mix (40/30/30) is an assumption, not a measurement of real
 * traffic: measured hit rates describe THIS workload and embedder only. Replace with real/anonymised prompts for a credible benchmark.
 */
const total = Number(process.argv[2] ?? 500), seed0 = Number(process.argv[3] ?? 1);
let s = seed0 >>> 0;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const topics = ['vector databases', 'token bucket rate limiting', 'circuit breakers', 'HTTP caching', 'database indexing', 'consistent hashing', 'the CAP theorem',
  'event sourcing', 'Bloom filters', 'B-trees', 'write-ahead logging', 'MVCC', 'Raft consensus', 'load balancing', 'DNS resolution', 'TLS handshakes', 'OAuth 2.0',
  'JWT tokens', 'gRPC', 'WebSockets', 'Server-Sent Events', 'Docker layers', 'container networking', 'garbage collection', 'memory-mapped files', 'the event loop',
  'async await', 'idempotency keys', 'backpressure', 'sharding', 'replication lag', 'leader election', 'rate limiting algorithms', 'cache invalidation', 'CDN edge caching',
  'SQL joins', 'query planners', 'connection pooling', 'tail latency', 'observability', 'distributed tracing', 'structured logging', 'feature flags', 'blue green deploys',
  'canary releases', 'semantic versioning', 'dependency injection', 'hexagonal architecture', 'the saga pattern', 'CRDTs', 'gossip protocols', 'vector embeddings',
  'cosine similarity', 'retrieval augmented generation', 'prompt caching', 'tokenization', 'quantization', 'LoRA fine-tuning', 'attention mechanisms', 'beam search'];
const base = (t) => `Explain ${t}.`;
const paraphrases = (t) => [`Can you explain ${t}?`, `Please explain ${t} to me.`, `Give me an explanation of ${t}.`, `What is ${t}? Explain.`];

const out = [], seen = [];
const nNew = Math.round(total * 0.4);
let ti = 0;
for (let i = 0; i < total; i++) {
  const mustBeNew = seen.length === 0 || (out.filter((o) => o.kind === 'new').length < nNew && rnd() < 0.5);
  if (mustBeNew && ti < topics.length * 4) {
    const t = topics[ti % topics.length], variant = Math.floor(ti / topics.length);
    const topic = variant === 0 ? t : `${t} (${['in practice', 'for beginners', 'at scale'][variant - 1]})`;
    ti++; seen.push(topic); out.push({ prompt: base(topic), kind: 'new', group: topic });
  } else if (rnd() < 0.5) {
    const g = pick(seen); out.push({ prompt: base(g), kind: 'exact_repeat', group: g });
  } else {
    const g = pick(seen); out.push({ prompt: pick(paraphrases(g)), kind: 'paraphrase', group: g });
  }
}
process.stdout.write(JSON.stringify(out));
const counts = out.reduce((m, o) => ((m[o.kind] = (m[o.kind] ?? 0) + 1), m), {});
console.error(`generated ${out.length} prompts:`, counts);
