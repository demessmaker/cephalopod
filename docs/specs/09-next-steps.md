# Cephalopod — Next Steps (post-Phase-1 plan)

Every milestone in `06-roadmap.md` is built (69 tests across `brain`, `mcp`,
`arm`, `web`, `spike`). The product is **feature-complete per spec but not yet
production-hardened**. This doc plans the remaining work.

**Chosen direction: agent-heavy automation.** After a minimal hardening pass, the
strategic investment is **Track B (agent safety & capability)** — make it safe and
controllable to point many AI agents at the graph.

## Now → near-term sequence

### N1 — CI ✅ (done)
GitHub Actions (`.github/workflows/ci.yml`) installs all packages and runs every
typecheck + test suite on push/PR.

### N2 — Close the WS policy gap ✅ (done)
**Was:** draft-gating (M6) and facet validation lived only in the HTTP layer, so a
WS writer (any editor-token *agent*) could apply CRDT deltas directly and create
live, un-gated notes.

**Done:** the connection now carries the principal `kind`; after an agent's WS
delta is applied, `SpaceHub.enforceAgentWrite` *corrects* post-hoc (a delta can't
be rejected once applied): stamps `authoredBy:agent`, forces `#draft` in draft-mode
spaces (an agent can't publish via WS), and quarantines facet-less notes with
`#needs-facets`. Humans (`kind !== "agent"`) are untouched. Covered by
`brain/test/ws-policy.test.ts` (agent forced to draft + hidden; human stays live;
facet-less agent note quarantined).

### N3 — Capability-scoped tokens ✅ (done) (`05 §2.2`)
Capabilities live on the **token** (a principal can hold several) and *intersect*
with the role — they only narrow it. Implemented:
- `mode:"read"` (read-only — no writes on HTTP **or** WS), `writeTags` (may only
  write notes carrying an allowed tag), `pathPrefix` (may only write within a
  `props.path` prefix).
- Stored as token JSON; enforced in HTTP (`require` + per-note `inScope`) and on
  WS (read-only via `canWrite`). MCP needs no change — an agent's token is
  enforced at the brain however it connects.
- Mint via `POST /principals {capabilities}` or `POST /tokens {principalId, capabilities}`.
- **Verified** (`brain/test/capabilities.test.ts`): read-only refused writes on
  HTTP and WS; tag-scoped token writes only its tag (and can't repurpose others);
  path-scoped token confined to its prefix; empty caps = full per role.

### N4 — Rate limits & quotas ✅ (done) (`05 §4–5`)
- Per-token **rate limit** (in-memory token bucket, `src/ratelimit.ts`): HTTP
  returns `429 {code:"rate_limited"}` + `Retry-After` when a token's bucket is
  empty. Configurable via `CEPH_RATE_RPM` (default 600/min); off in tests unless
  opted in. (Distributed/Redis limiter is a scale item.)
- Per-space **note quota** (`maxNotes` in space settings, 0 = unlimited): creates
  beyond it return `429 {code:"quota_exceeded"}`.
- **Verified** (`brain/test/limits.test.ts`): bucket refill math; HTTP 429 after
  burst; quota blocks the over-limit create and lifts when raised.

### N5 — Secret-scanning + hard-purge ✅ (done) (`05 §5`)
- Write-time **secret scan** (`src/secrets.ts`, curated high-precision patterns):
  per-space `secretScan` policy `off|warn|block` (default `warn`). `warn` tags the
  note `#secret-suspected`; `block` rejects with `422 {code:"secret_suspected", patterns}`.
- Admin **hard-purge** (`POST /spaces/:s/notes/:id/purge`): expunges the note from
  the log, snapshots, index, search, and embeddings, evicts it from memory, and
  writes an audit line. Admin-only; the one destructive op.
- **Verified** (`brain/test/secrets.test.ts`): scanner precision; warn-tags /
  block-rejects / off; purge removes a note from reads + search + log (a fresh
  store wouldn't rehydrate it); non-admin purge denied.

### N6 — Reversibility ✅ (done) (`05 §4`)
- The update log now records `actor` + `ts` per delta (blame/revert).
- `POST /spaces/:s/revert {principalId, since}` (admin): for each note the actor
  touched since `T`, reconstruct a "clean" doc by replaying the retained log tail
  *without* that actor's `ts >= T` deltas, then overwrite the live doc with the
  clean content via a new, attributed (`actor:"revert"`) edit — history-preserving,
  converges to arms. Audited.
- **Verified** (`brain/test/revert.test.ts`): an agent's poisoning of a human note
  is undone (original body/tags restored) and its junk note emptied, while the
  human's earlier edits survive; admin-only; `since` validated.
- *Limitation:* only edits still in the un-compacted log tail can be reverted
  (edits folded into a snapshot are not separable). Good enough for "undo recent
  agent damage"; deeper time-travel would need per-actor snapshot retention.

## Hardening backlog (Track A — fold in opportunistically)
- **Server hardening** — ✅ done: `/healthz` (+ Docker healthcheck), request
  body-size limit (`413`), WS auth via `Authorization` header / `bearer`
  subprotocol with `?token=` fallback (the CLI arm now uses the header). Structured
  request logging still TODO.
- **Extract `@cephalopod/core`** — ✅ done: canonical `ids`/`note`/`wikilinks`/
  `protocol` live in `/core`; `brain` and `arm` re-export them via thin
  `src/core/*` shims (call sites unchanged). Surfaced + fixed a latent null-byte
  in the `docKey` separator. (`spike` keeps its frozen M0 copy.)
- **Migration runner** — ✅ done: `brain/src/store/migrations.ts` runs ordered,
  recorded migrations (`schema_migrations` table); v1 is the consolidated,
  idempotent baseline that also upgrades legacy DBs. The constructor's ad-hoc
  guarded `ALTER`s are gone; future schema changes append a numbered migration.

**Track A (hardening) is complete.**

## Track C — Scale (SaaS)
- **C1 Postgres store — ✅ done, end-to-end.** `AsyncStore` (async mirror of
  `Store`) + `PgStore` (`store/pg.ts`): full contract on Postgres (native
  `tsvector` FTS; `bytea` embeddings scored in JS — add the `vector` extension +
  ANN index at scale). `asyncify()` lifts the sync store; `pgPool()` adapts
  production `pg`. **`SpaceHub`/`auth`/`http`/`server` are now async** and accept
  either backend (a sync store is lifted via `toAsync`). Concurrency: WS messages
  are serialized **per connection** (CRDT order), writes take a **per-doc lock**
  (atomic apply→gate→rollback→commit), and `getDoc` is **load-guarded**.
  Multi-statement ops (snapshot compaction, edge replace, purge) run in a
  **connection-scoped transaction** (`pool.connect()` per txn — `pool.query`
  BEGIN/COMMIT would smear across pooled connections), and `bytea` params bind as
  `Buffer` (a bare `Uint8Array` view mis-serializes under node-postgres).
  **Verified:** a backend-parity conformance suite (SQLite + PGlite), a
  Postgres-backed brain running the full HTTP stack (`pg-hub.test.ts`), a live
  async WS+HTTP server smoke, and a node-postgres txn-scoping + bytea test that
  PGlite (single-connection) can't surface (`pg-tx.test.ts`). (175 tests.)
- **C2 relay sharding — ✅ done (seam).** A `Broadcaster` (`src/broadcast.ts`)
  fans every committed delta out to other brain instances sharing one store; on
  receipt a hub keeps its in-memory doc coherent (if resident) and re-fans to its
  local connections **under the doc lock** (CRDT-causal delivery order), without
  re-persisting or re-broadcasting (origin-skip = no loop). Each message carries the
  store's monotonic log `seq`, so a broker that reorders/redelivers is **deduped**
  (no double-fan); `publish` errors are surfaced (not swallowed); and `SpaceHub.close()`
  **unsubscribes** (no leaked listener / zombie hub). The store stays the source of
  truth — broadcast is a liveness optimization. Default is single-instance; a
  `LocalBus` (shared `EventEmitter`) stands in for a real broker (NATS / Redis
  pub-sub / Postgres LISTEN-NOTIFY). **Verified** (`brain/test/broadcast.test.ts`):
  a write on hub A reaches a live connection on hub B and B's cache converges; no
  self-echo; redelivery is deduped; `close()` tears the subscription down;
  no-broadcaster behaves exactly as before.
- **C3 real embedding model — ✅ done (seam).** `Embedder.embed` is now `MaybeAsync`,
  and `ApiEmbedder` (`src/embedder.ts`) routes through any OpenAI-compatible
  `/embeddings` endpoint (OpenAI / Together / Ollama / vLLM / TEI) with configurable
  url/model/dim/key, request timeout, a dim-mismatch guard, and a **finite-value
  guard** (a `NaN`/`null` entry would poison every cosine score). The async hub
  awaits the embedder on both the index and query paths, but **fault-tolerantly**:
  an embed error/timeout never fails the write or de-syncs the rest of the derived
  index (node/FTS/edges) — it degrades semantic search for that one note, which
  re-embeds on the next edit. `embedderFromEnv` selects it via `CEPH_EMBED_URL`
  (default = the dependency-free hashing embedder). **Verified**
  (`brain/test/embedder.test.ts`): the ApiEmbedder normalizes / guards dim +
  non-finite / surfaces errors, env-selection, the hub indexes + queries end-to-end
  through an async model, and a failing embedder leaves the write durable + FTS
  intact. (pgvector/Qdrant ANN indexing over the stored `bytea` vectors is the
  remaining scale step.)
## Track D — UX
- **D1 Live editing in the explorer — ✅ done.** Build-less Yjs-in-browser editor:
  `web/src/edit.js` (`NoteSession`) mirrors the arm replica's sync handshake
  (`open`→`sync1`→`sync2`/`update`) against the brain WS, and `bindTextarea` two-way
  binds a `<textarea>` to the note's `body` Y.Text via a minimal-range diff
  (`yutil.js`). **Awareness/presence**: an ephemeral `awareness` WS frame
  (`y-protocols/awareness`) the brain relays to a note's co-watchers — never
  persisted, exempt from the write-path rate limit (`hub.handle`). Yjs is pulled from
  a CDN via an import map (tests resolve the same specifiers from `node_modules`).
  **Verified:** `web/test/edit.test.js` (edit convergence both ways, concurrent-edit
  CRDT merge, presence, textarea binding) + `brain/test/awareness.test.ts` (relay to
  co-watchers only, never persisted, rate-limit-exempt).
- **D2 Bidirectional Obsidian sync — ✅ done.** The inverse of the importer plus a
  content-hash reconcile: `markdown.ts` (`serializeNote` — frontmatter + body, id-
  links→`[[Title]]`), `export.ts` (`exportVault`, incremental via a sync manifest
  `id→{rel,vaultHash,brainHash}`), `sync.ts` (`syncVault` — per-note three-way
  reconcile: propagates vault-only and brain-only edits, creates in both directions,
  resolves both-sides conflicts by policy [default brain-wins, vault copy preserved
  under `.cephalopod/conflicts/` (outside the synced tree, so it isn't re-imported) +
  note tagged `sync-conflict`]). Vault/brain hashes are tracked independently so a
  settled tree re-syncs as a no-op. **All filesystem writes/deletes are contained**:
  `props.path`/title are sanitized (no `..`/absolute) and every write is gated by an
  `insideVault` check (defense-in-depth vs. a tampered manifest); the manifest load is
  corruption-tolerant and saved atomically (temp+rename). Export and sync share one
  path-assignment (duplicate titles disambiguate identically, full-id fallback so 3+
  collisions can't clobber), and the vault change-hash tolerates CRLF / trailing-
  whitespace churn (no phantom conflicts on Windows/Obsidian). `npm run export|sync`.
  **Verified** (`brain/test/obsidian-sync.test.ts`, 12 cases incl. round-trip
  stability, traversal containment, conflict-sidecar non-duplication, duplicate-title
  disambiguation, and CRLF tolerance).
- **D3 Attachments / blob store — ✅ done.** Content-addressed (blake3), per-space
  blob store behind the `Store` contract (`putBlob`/`getBlob`/`hasBlob`/`deleteBlob`
  on SQLite + Postgres; migration v2). `SpaceHub.putBlob` dedupes identical uploads
  and enforces a size cap (`maxBlobBytes`, default 25 MiB). HTTP: `POST
  /spaces/:s/blobs` (raw binary, write-gated, returns the content-addressed
  `{hash,size,type,url}`), `GET /spaces/:s/blobs/:hash` (read-gated, byte-exact,
  immutable-cacheable + ETag), and admin `DELETE`. Download is **XSS-hardened**: the
  stored content-type is honored only for an inline-safe image allowlist (SVG
  excluded), everything else is `attachment` + `application/octet-stream`, always with
  `nosniff`. A per-space **blob budget** (`blobBudgetBytes`, checked against
  `SUM(size)`; default 1 GiB in `server.ts`) bounds disk use → `507`; the per-object
  cap → `413`. The request layer buffers raw bytes (binary-safe) and only JSON-parses
  JSON bodies. The Obsidian importer's `attachments:"upload"` mode uploads referenced
  files and rewrites `![[img]]` → `![](…/blobs/<hash>)` (oversize/missing → warn +
  link, never aborts). **Verified:** `brain/test/blobs.test.ts`
  (upload/download/dedupe/413/507/auth, content-type hardening, admin delete) +
  blob round-trip + `blobBytes` in the backend-parity conformance suite + importer
  upload/oversize tests.
- **D — remaining:** VS Code plugin, Rust arm, in-browser attachment rendering.

## Track E — Ops ✅ (done)
- **Full-stack `docker-compose`** — adds a `web` service (build-less explorer,
  pure-stdlib `serve.mjs`, own Dockerfile + `.dockerignore`, `/healthz`) alongside the
  brain, wired `BRAIN_URL=http://brain:7701`, `depends_on: brain healthy`, both
  healthchecked and non-root. `docker compose config` validates the stack.
- **Observability** — `/metrics` (Prometheus text: request totals by status class,
  uptime, RSS via `src/metrics.ts`) and **structured per-request JSON logging**
  (method/path/status/ms), on by default (`CEPH_LOG=0` to silence). Both wired in
  `http.ts`/`server.ts`. Verified by `brain/test/metrics.test.ts`.
- **Backup/restore** — `npm run backup|restore` (`src/backup-cli.ts`) using SQLite's
  online `.backup()` API (WAL-aware, consistent against a live brain), not a file
  copy. Verified by `brain/test/backup.test.ts` (snapshot reopens with all data +
  blobs; restore round-trips).
- **`ARCHITECTURE.md`** — authoritative as-built reference (components, data model,
  concurrency, storage/scale, security, attachments, sync, ops), linked from the
  README; quickstart updated for the full stack + backup.
- *(Live container build/run not exercised in-sandbox — no Docker daemon — but compose
  config validates and the web image follows the proven brain Dockerfile pattern.)*

## Sequencing

```
N1 CI ✅ → N2 WS policy ✅ → N3 capability tokens ✅ → N4 rate limits ✅
         → N5 secret-scan/purge ✅ → N6 revert ✅          ← agent-safety track COMPLETE
```

The agent-safety track is done: agents are **gated** (draft), **scoped**
(capability tokens), **bounded** (rate/quota), **screened** (secret-scan), and
**reversible** (purge + revert). Remaining hardening backlog (extract
`@cephalopod/core`, migration runner, server hardening) and the deferred
scale/UX/ops tracks stay available; pick them up when there's a reason.
