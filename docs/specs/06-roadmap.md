# Cephalopod — Roadmap, Milestones & Open Questions

## 1. Phasing

The chosen pillars — **freeform graph + real-time CRDT + API/MCP-first** — argue
for proving the hard core (CRDT sync + agent surface) before any human UI.

### Phase 0 — Spec & prototype (this repo, now)
- These specs.
- Spike: Yjs per-note doc + graph-index doc, two Node replicas syncing through a
  trivial relay, wikilink→edge reconciliation. Prove convergence + subgraph
  caching end-to-end with no UI.

### Phase 1 — The brain (MVP)
- Sync Relay (WebSocket, ACL on subscribe/update), append-only log + snapshots on
  Postgres.
- Per-note + graph-index CRDT model (`02`), single index doc per space.
- HTTP Query/Command API (`03 §2`) with full-text search (PG FTS to start).
- Spaces, roles, tokens (`05` §1–2).
- **Obsidian vault importer**: map a markdown + `[[wikilink]]` vault into a space
  (~1:1), so teams arrive with a populated graph (decided seeding path).
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
- Graph-index partitioning / lazy neighborhoods (`02 §3.3`).
- Relay horizontal scaling + sharding (`04 §6`).
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

- [ ] M0 Convergence spike (2 replicas + relay, wikilink edges)
- [ ] M1 Relay + log + snapshots
- [ ] M2 HTTP API + FTS + spaces/auth
- [ ] M2.5 Obsidian vault importer + self-host packaging
- [ ] M3 CLI arm with offline cache + sync
- [ ] M4 MCP server (tools + resources)
- [ ] M5 Semantic search + hybrid ranking
- [ ] M6 Agent capabilities + provenance + draft-gate-by-default
- [ ] M7 Index partitioning + relay scaling
- [ ] M8 Web explorer/editor (north star)

## 3. Open questions (tracked)

| ID | Question | Status / decision |
|----|----------|-------------------|
| OQ-1 | Yjs vs Automerge for the CRDT core. | Default: Yjs (rich-text + ecosystem). |
| OQ-2 | Graph-index partitioning strategy for large spaces. | Default: single doc up to **v1 target ~50k notes / ~50 concurrent editors per space**, then path-prefix shards. Revisit if real target is ≫ that. |
| OQ-3 | Log retention / compaction policy & time-travel depth. | Default: keep full log; periodic snapshots; revisit cost. |
| OQ-4 | When (if) to introduce a dedicated graph DB. | Default: relational adjacency until traversal latency demands it. |
| OQ-5 | Native daemon language (TS vs Rust). | Default: TS first, Rust port in Phase 3. |
| OQ-6 | E2E encryption vs server-side search/embeddings. | Default: server-readable (search wins); E2E later/optional. |
| OQ-7 | Edge conflict semantics (add-wins vs remove-wins). | Default: add-wins, per-space configurable. |
| OQ-8 | Multi-tenant SaaS vs self-host-first. | ✅ **Resolved: self-host-first** for v1; SaaS is a later repackaging (`04 §6`). |

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
| 4 | **Scale target for v1.** | ⚙️ Planning default ~50k notes / ~50 concurrent editors per space (OQ-2) — confirm if your real target differs by an order of magnitude. |
| 5 | **Existing tools** — seed from imports vs clean. | ✅ Ship an Obsidian vault importer in v1 (Phase 1). |

### Still genuinely open for input
- **Scale (Q4)** is a *planning default*, not a confirmed requirement — give us
  real numbers when you have them; it's the main driver of OQ-2.
- The remaining technical OQs (1, 3–7) have defaults above and can be revisited
  during Phase-0/1 implementation without re-litigating product direction.
