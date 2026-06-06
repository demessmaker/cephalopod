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

### N2 — Close the WS policy gap  ‹small–med, do next›
**Gap:** draft-gating (M6) and required-facet validation are enforced only in the
HTTP layer. A client writing over the **WebSocket** (an arm, or any editor-token
*agent*) applies CRDT deltas directly, bypassing both. For agent-heavy use this is
the sharpest hole — an agent token could open a WS and write live, un-gated notes.

**Plan:** treat the WS as a *policy-enforced* path, not a trusted one.
- On `update`/`sync2`, after applying a delta, run the same provenance stamp +
  draft-gate + facet check the HTTP path uses (in `SpaceHub.commit`/`reindex`),
  keyed off the connection's principal kind and the space settings.
- Agent WS writes in a `draft` space → force `#draft` (or reject promotion of the
  draft tag); reject facet-less notes (or quarantine as `#draft` + `#needs-facets`).
- Distinguish principal kind on the WS connection (already known at auth).
- **Acceptance:** an agent token cannot create a live/un-faceted note via WS;
  a human (user) token is unaffected; covered by a new `brain` WS+policy test.

### N3 — Capability-scoped tokens  ‹med› (`05 §2.2`)
Today: per-space role (viewer/editor/admin). Add capability constraints that
*intersect* with the role:
- `mode: read-only`, tag scope (`read:#runbook`, `write:#decision`), path scope
  (`billing/**`), note allow/deny lists.
- Store on the token; enforce in HTTP + WS + MCP. Issue via `POST /principals`
  / a token-mint endpoint with a `capabilities` field.
- **Acceptance:** a read-only agent token is refused all writes; a tag-scoped
  token can only write notes carrying its allowed tag.

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
