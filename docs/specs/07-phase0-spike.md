# Cephalopod — Phase-0 Convergence Spike (M0)

A throwaway-but-real prototype whose only job is to **de-risk the architecture**
before Phase 1. It proves the claims the rest of the specs depend on; it is not
production code and ships no UI, auth, or persistence story.

> Builds on: `01-data-model.md`, `02-crdt-sync.md` (esp. §2.1–2.3, §3.3),
> `04-architecture.md §4`. Resolves the practical unknowns behind OQ-1 and OQ-2.

## 1. What the spike must prove

| # | Claim under test | From |
|---|------------------|------|
| C1 | Per-note Yjs docs **converge** under concurrent + offline edits, byte-for-byte. | `02 §6` |
| C2 | **Edges-on-source-note** (`outLinks` OR-Set) merge conflict-free; concurrent creation of the same edge is idempotent via deterministic ids. | `01 §2.3`, `02 §2.1` |
| C3 | **Wikilink edges** can be *derived* from converged bodies — same edges on every replica, no separate sync. | `02 §2.2` |
| C4 | A **server-derived adjacency** (no monolithic index doc) can answer `neighbors`/backlinks. | `02 §2.2`, `04 §4` |
| C5 | **Lazy-neighborhood scope fetch** streams only a bounded slice, not the whole graph. | `02 §3.3` |

If all five hold with acceptable delta sizes and adjacency-rebuild cost, the core
architecture is validated and Phase 1 proceeds on Yjs. The explicit failure
conditions in §9 are what would send us back to the drawing board (e.g. Automerge).

## 2. Scope & non-goals

**In scope:** a trivial WebSocket relay + two Node "arm" clients, per-note Yjs
docs, `outLinks`, wikilink parsing, in-memory server adjacency, lazy-neighborhood
subscribe, and an automated convergence test suite.

**Deliberately faked / omitted (NOT what we're testing):**

- No auth/ACL (every connection is god-mode).
- No durable persistence — relay state is in-memory; restart = clean slate.
  (We *do* test offline client survival via an in-memory queue, not disk.)
- No HTTP API, MCP, search, embeddings, or UI.
- No snapshots/compaction (full update log kept in RAM).
- `body` is a `Y.Text` of raw markdown, **not** `Y.XmlFragment` rich text — a
  spike simplification that keeps the wikilink parser trivial. (Rich-text is a
  Phase-1 concern; it does not change the convergence properties under test.)
- Wire format is JSON with base64-encoded Yjs update bytes — debuggable, not
  efficient. (Efficiency is measured, see §9, but optimizing it is out of scope.)

## 3. Topology

```
   ┌──────────────┐        ws         ┌───────────────────────────┐
   │  Arm A (Node) │◄─────────────────►│         Relay (Node)      │
   │  replica +    │                   │  • authoritative Y.Doc/note│
   │  local cache  │                   │  • in-mem update log       │
   └──────────────┘                   │  • derived adjacency       │
   ┌──────────────┐        ws         │  • scope resolver          │
   │  Arm B (Node) │◄─────────────────►│  • fan-out                 │
   └──────────────┘                   └───────────────────────────┘
```

The test harness can run all three in one process (in-memory transport) for
deterministic tests, or as separate processes over real WebSockets for a
smoke run.

## 4. Tech & dependencies

- **Runtime:** Node 20+, TypeScript.
- **CRDT:** `yjs`.
- **Sync primitives:** `y-protocols` (sync + awareness) for the state-vector
  exchange; `lib0/encoding` available if we drop JSON later.
- **Transport:** `ws`.
- **Test:** `vitest`.
- Nothing else. No DB, no framework.

## 5. The note document (spike schema)

Each note is a `Y.Doc`. Helper in `note.ts`:

```ts
// A note id is a ULID string prefixed "n_". Edge ids per 01 §2.3.
export interface NoteHandle {
  doc: Y.Doc;
  title: Y.Text;            // doc.getText("title")
  body: Y.Text;            // doc.getText("body")  -- raw markdown (spike)
  tags: Y.Array<string>;   // doc.getArray("tags")
  props: Y.Map<unknown>;   // doc.getMap("props")
  outLinks: Y.Map<OutLink>;// doc.getMap("outLinks") -- explicit edges, OR-Set
  meta: Y.Map<unknown>;    // doc.getMap("meta"): {createdAt, createdBy, deleted}
}

export interface OutLink { to: string; type: string | null; props?: Record<string, unknown>; }

export function edgeId(from: string, to: string, type: string | null): string {
  return "e_" + blake3(`${from}→${to}::${type ?? ""}`).slice(0, 24);
}
```

- **Explicit edge:** `outLinks.set(edgeId(from,to,type), {to,type})`. Idempotent:
  the same logical edge → same key on every replica (C2).
- **Wikilink edge:** never stored; derived from `body` (§7).

## 6. Wire protocol (`protocol.ts`)

All messages are JSON. `update`/`sv` payloads are base64 of Yjs binary.

```ts
type ClientMsg =
  | { t: "subscribe"; scope: Scope }                 // ask for a working set
  | { t: "open"; note: string }                       // begin syncing one note doc
  | { t: "sync1"; note: string; sv: b64 }             // my state vector
  | { t: "sync2"; note: string; update: b64 }         // diff vs peer SV
  | { t: "update"; note: string; update: b64 }        // a delta (steady state)
  | { t: "query";  q: GraphQuery; id: string };       // neighbors/backlinks

type ServerMsg =
  | { t: "slice"; nodes: NodeSummary[]; edges: EdgeRec[] } // lazy-neighborhood result
  | { t: "sync1"; note: string; sv: b64 }
  | { t: "sync2"; note: string; update: b64 }
  | { t: "update"; note: string; update: b64 }            // fan-out from a peer
  | { t: "result"; id: string; nodes: NodeSummary[]; edges: EdgeRec[] };

interface Scope { focus: string[]; hops: number; dir?: "out"|"in"|"both" }
interface GraphQuery { note: string; kind: "neighbors"|"backlinks"; hops?: number; dir?: "out"|"in"|"both" }
interface NodeSummary { id: string; title: string; tags: string[]; stub: boolean }
interface EdgeRec { from: string; to: string; type: string|null; origin: "wikilink"|"explicit" }
```

Sync is the standard Yjs two-step (`sync1`→`sync2` both directions), then
incremental `update`s — exactly `02 §3.2`, just JSON-wrapped.

## 7. Wikilink parsing & edge reconciliation (`wikilinks.ts`)

Pure function over body text → derived edges. Recomputed on every body change,
on whichever replica holds the note (and on the relay for the adjacency).

```ts
// Recognizes [[Target]], [[id|alias]], [[type:: Target]], [[code:: url]]
const WIKILINK = /\[\[\s*(?:([\w-]+)::\s*)?([^\]|]+?)\s*(?:\|[^\]]*)?\]\]/g;

export function deriveEdges(fromId: string, body: string, resolve: (titleOrId: string) => string): EdgeRec[] {
  const out: EdgeRec[] = [];
  for (const m of body.matchAll(WIKILINK)) {
    const type = m[1] ?? null;            // e.g. "depends_on", "code", or null
    const target = resolve(m[2].trim());   // title→id (or pass id through)
    out.push({ from: fromId, to: target, type, origin: "wikilink" });
  }
  return dedupeById(out);                   // edgeId() collapses duplicates → C3
}
```

- `resolve` is the §01-2.2 title→id rule. In the spike: if the title matches a
  known node use its id; else mint a **stub** node (id + empty doc, `stub:true`).
- Reconciliation = recompute derived edges for a note and replace that note's
  prior derived-edge contribution in the adjacency (set-diff add/remove).

## 8. Server-derived adjacency & scope resolver (`relay.ts`)

The relay holds, per note, the authoritative `Y.Doc`. On any note update it:

1. applies + logs + fans out the delta;
2. recomputes that note's **derived (wikilink) edges** from `body`;
3. reads that note's **explicit edges** from `outLinks`;
4. updates two in-memory maps:

```ts
nodes:    Map<string, NodeSummary>;          // id → summary
edges:    Map<string, EdgeRec>;              // edgeId → edge (out)
backIdx:  Map<string, Set<string>>;          // toId → set<edgeId>   (reverse, for backlinks)
```

**Scope resolution** (`subscribe`/`query`) = BFS over `edges`/`backIdx` from
`focus` up to `hops`, bounded:

```ts
function resolveScope(s: Scope): { nodes: NodeSummary[]; edges: EdgeRec[] } {
  const seen = new Set(s.focus); const frontier = [...s.focus];
  const picked: EdgeRec[] = [];
  for (let h = 0; h < s.hops; h++) {
    const next: string[] = [];
    for (const id of frontier) for (const e of adjacentEdges(id, s.dir)) {
      picked.push(e);
      const other = e.from === id ? e.to : e.from;
      if (!seen.has(other)) { seen.add(other); next.push(other); }
    }
    frontier.length = 0; frontier.push(...next);
  }
  return { nodes: [...seen].map(id => nodes.get(id)!), edges: picked };
}
```

The relay replies with a `slice` (the bounded node/edge set) — proving C5 — then
opens Yjs sync for whichever notes the arm chooses to `open`.

## 9. Acceptance scenarios (the deliverable)

Automated in `test/convergence.test.ts`. Each asserts a precise, machine-checkable
property. **Convergence check** = after quiescence, both replicas satisfy
`Y.encodeStateVector(a) deepEquals Y.encodeStateVector(b)` AND a field-level value
compare matches.

| ID | Scenario | Assertion | Proves |
|----|----------|-----------|--------|
| S1 | A and B edit **different paragraphs** of the same note's body concurrently. | Both bodies contain both edits; replicas converge. | C1 |
| S2 | A and B **both rename the title** concurrently to different strings. | Both replicas show the *same* winning title (deterministic). | C1 |
| S3 | B goes **offline**, both edit body, B reconnects. | No lost edits; replicas converge after resync. | C1 |
| S4 | A adds `[[B]]` to its body. | Edge A→B appears in relay adjacency; `query backlinks(B)` returns it. | C3, C4 |
| S5 | A and B **both** add an explicit link A→C concurrently. | Exactly **one** edge A→C exists (deterministic id). | C2 |
| S6 | A removes the `[[B]]` wikilink; B concurrently adds `[[D]]`. | Final derived edges = {A→D} only; converges. | C3 |
| S7 | Subscribe `{focus:[A], hops:1}` in a 100-note graph where A has 3 neighbors. | `slice` contains exactly A + its 3 neighbors (+ their edges), **not** all 100. | C5 |
| S8 | After S1–S6, dump full state of A and B. | `encodeStateAsUpdate` diff is empty both ways. | C1 (strong) |

**Measured (reported, not pass/fail):**
- M-size: median + p99 `update` delta bytes for a one-character body edit.
- M-rebuild: wall-time to recompute one note's derived edges + adjacency patch.
- M-load: time + bytes to resolve & stream a `hops:2` scope over a synthetic
  250k-node graph (generator script) — sanity check on `02 §3.3` at target scale.

### Decision gates (what would change our minds)
- If single-char edits produce multi-KB deltas, or adjacency patch per edit is
  >~1ms at 250k nodes → revisit data layout (and reconsider OQ-1 Automerge).
- If scope resolution at 250k can't stay bounded/fast → the lazy-neighborhood
  approach (`02 §3.3`) needs the dedicated graph store sooner (OQ-4).

## 10. Project layout

```
spike/
  package.json            # yjs, y-protocols, ws, vitest, blake3
  src/
    note.ts               # §5 schema helpers, edgeId
    wikilinks.ts          # §7 parser + deriveEdges
    protocol.ts           # §6 message types + (de)serialize
    relay.ts              # §8 ws server, adjacency, scope resolver, fan-out
    client.ts             # arm: connect, open, edit ops, local cache, query
    memtransport.ts       # in-process transport for deterministic tests
    gen.ts                # synthetic 250k-node graph generator (for M-load)
  test/
    convergence.test.ts   # §9 S1–S8 + measurements
  README.md               # how to run; what it proves; what it fakes
```

## 11. Build plan (M0 checklist)

- [ ] 1. `note.ts` + `edgeId` + a unit test for deterministic edge ids.
- [ ] 2. `wikilinks.ts` + tests for the parser (typed, aliased, code, stub cases).
- [ ] 3. `protocol.ts` + `memtransport.ts` (in-process pub/sub).
- [ ] 4. `relay.ts`: per-note `Y.Doc`, apply/log/fan-out, adjacency, scope BFS.
- [ ] 5. `client.ts`: sync handshake, edit ops (`setTitle`, `appendBody`,
      `link`), local cache of `slice`, `query`.
- [ ] 6. `convergence.test.ts`: S1–S8 over `memtransport` (deterministic).
- [ ] 7. `gen.ts` + M-size/M-rebuild/M-load measurements; record in README.
- [ ] 8. Real-WebSocket smoke run (two processes) to confirm it isn't an
      in-memory artifact.
- [ ] 9. Write up findings + decision-gate results → feeds Phase-1 go/no-go.

## 12. Exit criteria

M0 is done when S1–S8 pass deterministically, the real-WebSocket smoke run
converges, and the three measurements are recorded with a one-paragraph verdict
on each decision gate in §9. That verdict is the Phase-1 green light.
