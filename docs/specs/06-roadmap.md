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
- **Exit criteria**: a CLI arm can cache a scope, edit offline, sync, and two
  arms converge; all reads/writes ACL-enforced and attributed.

### Phase 2 — Agent-native (the differentiator)
- `cephalopod-mcp` server: tools, resources, subscriptions (`03 §4`).
- Vector/semantic search (pgvector) + hybrid ranking.
- Capability-scoped agent tokens, provenance flags, draft/review gate (`05 §4`).
- **Exit criteria**: an agent can search, read, write, link, and *watch* the
  graph over MCP, with writes attributed and scope-limited.

### Phase 3 — Scale & ergonomics
- Graph-index partitioning / lazy neighborhoods (`02 §3.3`).
- Relay horizontal scaling + sharding (`04 §6`).
- Native Rust dev daemon; richer CLI.
- Dedicated graph/vector stores if needed (`04 §4`).

### Phase 4 — Human surfaces (north star, was out of v1 scope)
- Web graph explorer + editor (ProseMirror over the same Yjs docs — live
  multiplayer "for free").
- IDE/editor plugin surfacing the subgraph next to code.
- Awareness/presence in the UI (humans + agents shown editing together).

## 2. Milestone checklist

- [ ] M0 Convergence spike (2 replicas + relay, wikilink edges)
- [ ] M1 Relay + log + snapshots
- [ ] M2 HTTP API + FTS + spaces/auth
- [ ] M3 CLI arm with offline cache + sync
- [ ] M4 MCP server (tools + resources)
- [ ] M5 Semantic search + hybrid ranking
- [ ] M6 Agent capabilities + provenance + review gate
- [ ] M7 Index partitioning + relay scaling
- [ ] M8 Web explorer/editor (north star)

## 3. Open questions (tracked)

| ID | Question | Current default |
|----|----------|-----------------|
| OQ-1 | Yjs vs Automerge for the CRDT core. | Yjs (rich-text + ecosystem). |
| OQ-2 | Graph-index partitioning strategy for large spaces. | Single doc → path-prefix shards. |
| OQ-3 | Log retention / compaction policy & time-travel depth. | Keep full log; periodic snapshots; revisit cost. |
| OQ-4 | When (if) to introduce a dedicated graph DB. | Relational adjacency until traversal latency demands it. |
| OQ-5 | Native daemon language (TS vs Rust). | TS first, Rust port in Phase 3. |
| OQ-6 | E2E encryption vs server-side search/embeddings. | Server-readable (search wins); E2E later/optional. |
| OQ-7 | Edge conflict semantics (add-wins vs remove-wins). | Add-wins default, per-space configurable. |
| OQ-8 | Multi-tenant SaaS vs self-host-first. | Self-host-first; SaaS later. |

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

## 5. Questions for the product owner

These shape the next spec iteration — answers welcome:

1. **Deployment**: self-host-first (per-team brain) confirmed, or do you want
   SaaS multi-tenancy from day one? (Drives OQ-8 and `04 §6`.)
2. **Agent autonomy**: should agents be able to write to shared knowledge freely,
   or always land in a `#draft` review queue by default? (Drives `05 §4`.)
3. **Boundary with code**: how tightly should notes bind to actual code symbols/
   repos — just URLs, or live references (e.g. resolve a `[[symbol::]]` to a real
   definition via LSP)? (Could add a structured-link convention.)
4. **Scale target for v1**: rough notes-per-space and concurrent-editors numbers,
   so we can size the single-index-doc cutoff (OQ-2) realistically.
5. **Existing tools**: should v1 import from / sync with Obsidian vaults or a wiki
   to seed graphs, or start clean?
