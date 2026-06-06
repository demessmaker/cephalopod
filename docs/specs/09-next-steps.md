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
- **Extract `@cephalopod/core`** — kill the triplicated `note`/`ids`/`protocol`/
  `wikilinks` across `brain`/`arm`/`spike`; single source of truth.
- **Migration runner** — replace the ad-hoc guarded `ALTER` with ordered, recorded
  migrations (matters as the schema keeps evolving here).
- **Server hardening** — request body-size limits, WS token via header/subprotocol
  (not URL query, which leaks into logs), `/healthz`, structured request logging.

## Deferred tracks (revisit if direction shifts)
- **C — Scale (SaaS):** Postgres `Store`, relay sharding (NATS/Redis fan-out),
  real embedding model + pgvector/Qdrant behind the `Embedder` seam. Only needed
  for multi-tenant or ≫250k-note spaces.
- **D — UX:** inline editing in the explorer (Yjs-in-browser + awareness/presence),
  attachments/blob store, bidirectional Obsidian sync, VS Code plugin, Rust arm.
- **E — Ops:** full-stack `docker-compose` (brain + web), metrics/tracing,
  backup/restore tooling, `ARCHITECTURE.md`, open the PR.

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
