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

### N4 — Rate limits & quotas  ‹small–med› (`05 §4–5`)
Per-token request rate limit + per-space write quota; typed `rate_limited` error.
Bounds runaway agents. **Acceptance:** an agent exceeding its rate gets 429s; humans unaffected.

### N5 — Secret-scanning + hard-purge  ‹med› (`05 §5`)
- On write, scan title/body for secret patterns (API keys/tokens); warn or block
  per space policy; flag `secret_suspected`.
- Admin **hard-purge**: rewrite log + snapshots to expunge a note/secret and
  force-resync arms (the one destructive, audited op we specced but never built).
- **Acceptance:** a planted fake key is flagged; purge removes a note from log,
  snapshots, index, and search.

### N6 — Reversibility  ‹med› (`05 §4`)
Admin "revert principal X's edits since T" by applying inverse CRDT deltas (soft,
history-preserving). Critical safety valve for agent-poisoned knowledge.
**Acceptance:** an admin reverts an agent's last-hour edits; prior human edits survive.

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
N1 CI ✅ → N2 WS policy → N3 capability tokens → N4 rate limits
         → N5 secret-scan/purge → N6 revert
   (extract core + migration runner folded in around N2–N3)
```

N2–N6 together make the system **safe to hand to autonomous agents at volume** —
the point of the chosen direction. Scale (C) and rich UX (D) wait until there's a
reason (a SaaS tenant, or a human-editing push).
