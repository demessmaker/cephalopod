# Cephalopod — Roadmap, Milestones & Open Questions

## 1. Phasing

The chosen pillars — **freeform graph + real-time CRDT + API/MCP-first** — argue
for proving the hard core (CRDT sync + agent surface) before any human UI.

### Phase 0 — Spec & prototype (this repo, now)
- These specs.
- Spike: Yjs per-note docs (body + `outLinks`), two Node replicas syncing through
  a trivial relay that maintains a server-derived adjacency, wikilink→edge
  reconciliation. Prove convergence + lazy-neighborhood scope fetch with no UI.

### Phase 1 — The brain (MVP)
- Sync Relay (WebSocket, ACL on subscribe/update), append-only log + snapshots on
  Postgres.
- Per-note CRDT model with edges on the source note (`02 §2.1`), plus a
  **server-derived graph index** (Postgres) and **lazy-neighborhood scope
  resolution** — no monolithic index doc (required by the ~250k-note target).
- HTTP Query/Command API (`03 §2`) with full-text search (PG FTS to start).
- Spaces, roles, tokens (`05` §1–2).
- **Obsidian vault importer**: map a markdown + `[[wikilink]]` vault into a space
  (~1:1), so teams arrive with a populated graph (decided seeding path) — full
  spec in `08-obsidian-import.md`.
- Single-tenant self-host packaging (Docker Compose) — `04 §6`, the decided v1
  deployment model.
- **Exit criteria**: a CLI arm can cache a scope, edit offline, sync, and two
  arms converge; all reads/writes ACL-enforced and attributed; an Obsidian vault
  imports cleanly.

### Phase 2 — Agent-native (the differentiator)
- `cephalopod-mcp` server: tools, resources, subscriptions (`03 §4`).
- Vector/semantic search (pgvector) + hybrid ranking.
- Capability-scoped agent tokens, provenance flags, **draft-gate-by-default** for
  agent writes (`05 §4`, the decided autonomy model).
- **Exit criteria**: an agent can search, read, write, link, and *watch* the
  graph over MCP, with writes attributed, scope-limited, and landing as `#draft`
  until a human promotes them.

### Phase 3 — Scale & ergonomics
- Relay horizontal scaling + sharding (`04 §6`).
- Dedicated graph store if traversal latency demands it (OQ-4); index
  partitioning beyond the single-Postgres read-model.
- Native Rust dev daemon; richer CLI.
- Dedicated graph/vector stores if needed (`04 §4`).
- **Live code-symbol resolution**: bind reserved `[[symbol::]]` refs (`01 §2.1`)
  to real definitions via per-repo LSP indexing — the upgrade from v1 URL-only.

### Phase 4 — Human surfaces (north star, was out of v1 scope)
- Web graph explorer + editor (ProseMirror over the same Yjs docs — live
  multiplayer "for free").
- IDE/editor plugin surfacing the subgraph next to code.
- Awareness/presence in the UI (humans + agents shown editing together).

## 2. Milestone checklist

- [x] M0 Convergence spike (2 replicas + relay, wikilink edges) — spec `07`, code in `/spike` (✅ all gates passed)
- [x] M1 Relay + log + snapshots — code in `/brain` (✅ persistence, restart, snapshots, spaces, derived index)
- [x] M2 HTTP API + FTS + spaces/auth — code in `/brain` (✅ REST API, FTS5 search, tokens, per-space RBAC on HTTP + WS)
- [x] M2.5 Obsidian vault importer (`08`) — code in `/brain` (✅ two-pass, links/stubs/embeds, frontmatter, idempotent re-import, write-back). Self-host packaging still TODO.
- [ ] M3 CLI arm with offline cache + sync
- [x] M4 MCP server (tools) — code in `/mcp` (✅ 9 agent tools over the brain API; resources/subscriptions = M4.1)
- [ ] M5 Semantic search + hybrid ranking
- [ ] M6 Agent capabilities + provenance + draft-gate-by-default
- [ ] M7 Index partitioning + relay scaling
- [ ] M8 Web explorer/editor (north star)

## 3. Open questions (tracked)

| ID | Question | Status / decision |
|----|----------|-------------------|
| OQ-1 | Yjs vs Automerge for the CRDT core. | Default: Yjs (rich-text + ecosystem). |
| OQ-2 | Graph-index strategy for large spaces. | ✅ **Resolved** by the ~250k-note target: no monolithic index doc; **server-derived index (Postgres) + lazy-neighborhood scope resolution** (`02 §2.2`, `§3.3`). |
| OQ-3 | Log retention / compaction policy & time-travel depth. | Default: keep full log; periodic snapshots; revisit cost. |
| OQ-4 | When (if) to introduce a dedicated graph DB. | Default: relational adjacency until traversal latency demands it. |
| OQ-5 | Native daemon language (TS vs Rust). | Default: TS first, Rust port in Phase 3. |
| OQ-6 | E2E encryption vs server-side search/embeddings. | Default: server-readable (search wins); E2E later/optional. |
| OQ-7 | Edge conflict semantics (add-wins vs remove-wins). | Default: add-wins, per-space configurable. |
| OQ-8 | Multi-tenant SaaS vs self-host-first. | ✅ **Resolved: self-host-first** for v1; SaaS is a later repackaging (`04 §6`). |
| OQ-9 | Map Obsidian Dataview inline fields (`key:: value`) to typed edges/props? | Default: no in v1; treat as text (`08 §9`). |
| OQ-10 | Blob store backend for attachments. | Default: S3-compatible object store (`08 §9`, `04 §2.3`). |
| OQ-11 | Import manifest location (in-vault vs server record). | Default: server record per space; optional in-vault copy (`08 §9`). |

## 4. Risks

- **CRDT scale**: large note bodies / very active graphs stress memory on the
  relay. Mitigation: per-doc hot/cold management, snapshots, sharding.
- **Freeform → uselessly messy**: no schema can mean low-signal graphs.
  Mitigation: strong tag conventions, MCP prompts (`03 §4.4`), and agents that
  help curate/link.
- **Agent write trust**: shared memory poisoned by a bad agent. Mitigation:
  provenance, draft gates, reversibility, scoped tokens (`05 §4`).
- **Search relevance for agents**: bad retrieval makes the second brain useless
  to agents. Mitigation: hybrid (text+vector+graph-proximity) ranking, evaluated
  against real agent queries.

## 5. Product-owner decisions (resolved)

| # | Question | Decision |
|---|----------|----------|
| 1 | **Deployment** — self-host vs SaaS. | ✅ Self-host-first; SaaS later (OQ-8, `04 §6`). |
| 2 | **Agent autonomy** — free write vs review queue. | ✅ Draft-gate by default; per-space opt-out (`05 §4`). |
| 3 | **Boundary with code** — URLs vs live symbols. | ✅ URLs only in v1; `[[symbol::]]` syntax reserved for Phase-3 LSP resolution (`01 §2.1`). |
| 4 | **Scale target for v1.** | ✅ **~250k notes/space**, **~50 concurrent editors/space** (humans + agents), **~1–10 spaces / <100 users** per self-hosted brain, **agent load comparable to humans**. Drove the OQ-2 index redesign (`02 §2.2`). |
| 5 | **Existing tools** — seed from imports vs clean. | ✅ Ship an Obsidian vault importer in v1 (Phase 1). |

### Scale target — implications now baked into the specs
- **~250k notes/space** → no monolithic index CRDT doc; server-derived index +
  lazy-neighborhood resolution (`02 §2.2`, `§3.3`); Postgres adjacency required
  from v1 (`04 §2.4`, `§4`).
- **~50 concurrent editors/space** → a single relay instance suffices for v1;
  horizontal relay sharding deferred to Phase 3.
- **~1–10 spaces, <100 users/brain** → modest single-box self-host; Postgres +
  services co-located is fine.
- **Agent load ≈ human load** → plan steady agent QPS, draft-gate throughput, and
  continuous embedding recompute in the indexer pipeline (`03 §3`, `05 §4`).

### Still open (technical, non-blocking)
- The remaining technical OQs (1, 3–7) have defaults above and can be revisited
  during Phase-0/1 implementation without re-litigating product direction.
