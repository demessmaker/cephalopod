// Pluggable embeddings (03 §3 / 01 §4). The default is a dependency-free,
// deterministic feature-hashing embedder so semantic search works out of the box
// for self-host; a real model (transformers.js or an API) can implement the same
// interface and run as an async indexer at scale.
export interface Embedder {
  readonly dim: number;
  embed(text: string): Float32Array; // L2-normalized
}

export class HashingEmbedder implements Embedder {
  constructor(public readonly dim = 256) {}

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const tok of tokens) {
      const h = hash32(tok);
      const idx = h % this.dim;
      const sign = (hash32("s:" + tok) & 1) === 0 ? 1 : -1; // signed feature hashing
      v[idx] += sign;
    }
    // L2 normalize so cosine similarity == dot product
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dim; i++) v[i] /= norm;
    return v;
  }
}

// Dot product of two equal-length, L2-normalized vectors == cosine similarity.
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function hash32(s: string): number {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
