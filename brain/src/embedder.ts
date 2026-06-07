// Pluggable embeddings (03 §3 / 01 §4). The default is a dependency-free,
// deterministic feature-hashing embedder so semantic search works out of the box
// for self-host; a real model (transformers.js or an API) can implement the same
// interface and run as an async indexer at scale.
//
// `embed` is MaybeAsync: the in-process HashingEmbedder returns synchronously, but
// a real model behind a network/worker (ApiEmbedder) returns a Promise. The hub
// awaits the result either way.
export type MaybeAsync<T> = T | Promise<T>;

export interface Embedder {
  readonly dim: number;
  embed(text: string): MaybeAsync<Float32Array>; // L2-normalized
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
    return l2normalize(v);
  }
}

// A real embedding model behind an OpenAI-compatible `/embeddings` endpoint
// (OpenAI, Together, Ollama, vLLM, text-embeddings-inference, …). Stays behind the
// same `Embedder` seam so the hub is model-agnostic; runs as an async indexer.
// Configure via env (see `embedderFromEnv`) or construct directly.
export interface ApiEmbedderOptions {
  url: string; // full endpoint, e.g. https://api.openai.com/v1/embeddings
  model: string; // e.g. text-embedding-3-small
  dim: number; // vector dimension the model returns (must match the store/index)
  apiKey?: string; // sent as `Authorization: Bearer <key>` when present
  fetchImpl?: typeof fetch; // injectable for tests
  timeoutMs?: number; // abort a hung request (default 15s)
}

export class ApiEmbedder implements Embedder {
  readonly dim: number;
  private readonly url: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ApiEmbedderOptions) {
    this.dim = opts.dim;
    this.url = opts.url;
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async embed(text: string): Promise<Float32Array> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`embedder ${this.url} -> ${res.status}`);
      const json = (await res.json()) as { data?: { embedding: number[] }[] };
      const raw = json.data?.[0]?.embedding;
      if (!raw) throw new Error(`embedder ${this.url}: no embedding in response`);
      if (raw.length !== this.dim) throw new Error(`embedder dim mismatch: got ${raw.length}, expected ${this.dim}`);
      return l2normalize(Float32Array.from(raw));
    } finally {
      clearTimeout(timer);
    }
  }
}

// Select an embedder from the environment. Defaults to the dependency-free hashing
// embedder; set CEPH_EMBED_URL to route through a real model. (Changing the
// embedder/dim for an existing store requires a reindex — vectors aren't comparable
// across models.)
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder {
  if (!env.CEPH_EMBED_URL) return new HashingEmbedder(Number(env.CEPH_EMBED_DIM ?? 256));
  return new ApiEmbedder({
    url: env.CEPH_EMBED_URL,
    model: env.CEPH_EMBED_MODEL ?? "text-embedding-3-small",
    dim: Number(env.CEPH_EMBED_DIM ?? 1536),
    apiKey: env.CEPH_EMBED_KEY,
  });
}

// L2 normalize in place so cosine similarity == dot product.
function l2normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
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
