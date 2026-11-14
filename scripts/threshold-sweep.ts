import { readFileSync } from 'node:fs';
import { cosineSimilarity, createEmbeddingProvider } from '../packages/cache/src/embedding';

/**
 * Offline threshold tuning. Input: JSONL lines {"a": "...", "b": "...", "match": true|false}
 * where match=true means the two prompts should share a cached answer.
 * Usage: EMBEDDING_PROVIDER=hash npm run threshold-sweep -- path/to/pairs.jsonl
 * Output is computed on YOUR labelled data only; the bundled example file is a format demo, not a benchmark.
 */
async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('usage: npm run threshold-sweep -- <pairs.jsonl>');
  const kind = process.env.EMBEDDING_PROVIDER === 'transformers' ? 'transformers' : 'hash';
  const embedder = createEmbeddingProvider(kind);
  const pairs = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { a: string; b: string; match: boolean });

  const scored: Array<{ sim: number; match: boolean }> = [];
  for (const p of pairs) {
    scored.push({ sim: cosineSimilarity(await embedder.embed(p.a), await embedder.embed(p.b)), match: p.match });
  }
  console.log(`embedder=${embedder.name} pairs=${pairs.length}`);
  console.log('threshold  precision  recall  false_hits  missed_hits');
  for (let t = 0.5; t <= 0.995; t += 0.05) {
    const tp = scored.filter((s) => s.sim >= t && s.match).length;
    const fp = scored.filter((s) => s.sim >= t && !s.match).length;
    const fn = scored.filter((s) => s.sim < t && s.match).length;
    const precision = tp + fp === 0 ? NaN : tp / (tp + fp);
    const recall = tp + fn === 0 ? NaN : tp / (tp + fn);
    console.log(`${t.toFixed(2)}       ${precision.toFixed(3)}      ${recall.toFixed(3)}   ${fp}           ${fn}`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
