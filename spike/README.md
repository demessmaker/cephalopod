# Cephalopod — Phase-0 Convergence Spike (M0)

A throwaway-but-real prototype that de-risks the architecture before Phase 1.
Full spec: [`../docs/specs/07-phase0-spike.md`](../docs/specs/07-phase0-spike.md).

> **Status: M0 passed.** All acceptance scenarios green; convergence holds over
> both in-process and real WebSocket transports; scope resolution is bounded and
> fast at the 250k-node target. Verdict on each decision gate below.

## Run it

```bash
npm install
npm test              # S1–S8 acceptance scenarios + measurements (vitest)
npm run smoke         # real-WebSocket convergence smoke run
npm run gen           # scope-resolution benchmark (CEPH_SCALE=250000 npm run gen)
```

## What it proves (and what it deliberately fakes)

See `07 §1` (claims C1–C5) and `07 §2` (non-goals). In short: per-note Yjs docs,
edges-on-source-note, derived wikilink edges, a server-derived adjacency, and
lazy-neighborhood scope fetch — **no** auth, persistence, UI, or MCP.

## Source map

| File | Role |
|------|------|
| `src/note.ts` | Yjs note schema + `edgeId`/`stubId` |
| `src/wikilinks.ts` | wikilink parser + `deriveEdges` |
| `src/protocol.ts` | wire messages + `Conn` interface |
| `src/memtransport.ts` | in-process transport (sync delivery, offline sim) |
| `src/relay.ts` | authoritative docs, server-derived adjacency, scope resolver, fan-out |
| `src/client.ts` | an "arm": replica, edit ops, graph queries |
| `src/ws.ts` / `src/smoke.ts` | real-WebSocket adapter + smoke run |
| `src/gen.ts` | synthetic graph generator + benchmark |
| `test/convergence.test.ts` | S1–S8 + measurements |

## Results (this machine)

```
S1–S8: 9 passed (9)                      # incl. measurements case
WS smoke: ✅ converged over real WebSockets

M-size:   24 bytes / 1-char edit
M-derive: ~0.3 ms / 20-link note
M-load @ 250k nodes:
  hops=1: ~17 ms (cold) -> 5 nodes
  hops=2:  ~1 ms        -> 21 nodes
  hops=3:  ~2 ms        -> 60 nodes
```

## Findings → fed back into the specs

1. **`title` must be an LWW field, not `Y.Text`.** The spec originally modeled
   `title` as `Y.Text`; the spike showed two concurrent renames *character-merge*
   into `"Title-BTitle-A"` (deterministic, but not last-writer-wins). Scalars that
   want LWW belong in a `Y.Map` (here `meta.title`). `02 §2.1` and `07 §5` updated.
   Bodies stay `Y.Text` — collaborative merge is correct there.
2. **Lazy-neighborhood resolution is viable at target scale (OQ-2).** Bounded,
   single-digit-ms scope fetches over a 250k-node graph from an in-memory
   adjacency — no monolithic index doc needed, dedicated graph store not required
   for v1 (OQ-4 stays deferred).
3. **Yjs deltas are tiny (24 B for a keystroke) (OQ-1).** No reason to revisit
   Yjs for Phase 1.

## Decision-gate verdict (07 §9)

| Gate | Verdict |
|------|---------|
| Delta size acceptable? | ✅ 24 B/edit |
| Adjacency patch cheap? | ✅ sub-ms derive |
| Scope bounded/fast @ 250k? | ✅ 1–2 ms for hops 2–3 |

→ **Phase 1 green light.** (The only model change is title-as-LWW, already folded
back into the specs.)
