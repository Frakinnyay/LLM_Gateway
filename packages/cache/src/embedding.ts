export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  /** Returns an L2-normalised vector of length `dimensions`. */
  embed(text: string): Promise<number[]>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number, y = b[i] as number;
    dot += x * y; na += x * x; nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Zero-dependency, deterministic embedding via the hashing trick over word unigrams,
 * word bigrams and character trigrams (signed buckets to reduce collision bias).
 *
 * HONEST LIMITATION: this measures LEXICAL overlap. "How do I reset my password" and
 * "I forgot my login credentials" share few words and will NOT match; true paraphrase
 * detection needs a neural model (use EMBEDDING_PROVIDER=transformers). It is useful
 * because it costs nothing, needs no download, and makes the pgvector pipeline testable.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hash-v1';
  constructor(readonly dimensions = 384) {}

  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dimensions).fill(0);
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const add = (feature: string, weight: number): void => {
      const idx = fnv1a(feature) % this.dimensions;
      const sign = fnv1a(feature, 0x9747b28c) & 1 ? 1 : -1;
      v[idx] = (v[idx] as number) + sign * weight;
    };
    words.forEach((w, i) => {
      add(`u:${w}`, 1);
      if (i > 0) add(`b:${words[i - 1]} ${w}`, 0.7);
      for (let k = 0; k + 3 <= w.length; k++) add(`c:${w.slice(k, k + 3)}`, 0.25);
    });
    if (words.length === 0) add(`raw:${text}`, 1); // never return a zero vector
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

interface FeatureExtractor {
  (text: string, opts: { pooling: string; normalize: boolean }): Promise<{ data: ArrayLike<number> }>;
}

/**
 * Local neural embeddings (all-MiniLM-L6-v2, 384-d) through the OPTIONAL package
 * @xenova/transformers. Loaded lazily so the default install needs nothing extra.
 * UNVERIFIED in this repository until you install the package and run it.
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'transformers-all-MiniLM-L6-v2';
  readonly dimensions = 384;
  private extractor: Promise<FeatureExtractor> | null = null;

  private load(): Promise<FeatureExtractor> {
    if (!this.extractor) {
      // Indirect dynamic import: the package is ESM-only and this project compiles to CommonJS.
      const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<{
        pipeline: (task: string, model: string) => Promise<FeatureExtractor>;
      }>;
      this.extractor = dynamicImport('@xenova/transformers')
        .then((m) => m.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'))
        .catch((err: Error) => {
          this.extractor = null;
          throw new Error(`EMBEDDING_PROVIDER=transformers requires: npm i @xenova/transformers (${err.message})`);
        });
    }
    return this.extractor;
  }

  async embed(text: string): Promise<number[]> {
    const ex = await this.load();
    const out = await ex(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  }
}

export function createEmbeddingProvider(kind: 'hash' | 'transformers', dimensions = 384): EmbeddingProvider {
  return kind === 'transformers' ? new TransformersEmbeddingProvider() : new HashingEmbeddingProvider(dimensions);
}
