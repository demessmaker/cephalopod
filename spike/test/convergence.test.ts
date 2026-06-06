// §9 — acceptance scenarios. Convergence = identical Yjs state vectors + equal
// materialized values after quiescence. Memtransport delivers synchronously, so
// "concurrent" edits are simulated by disconnecting both arms, editing, then
// reconnecting and re-syncing (CRDT reconciles via the state-vector handshake).
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { Relay } from "../src/relay.js";
import { Client } from "../src/client.js";
import { createPair, type Pair } from "../src/memtransport.js";
import { newNoteId, stubId, edgeId } from "../src/note.js";
import { deriveEdges } from "../src/wikilinks.js";
import type { ClientMsg, ServerMsg } from "../src/protocol.js";

function setup() {
  const relay = new Relay();
  const pa = createPair<ClientMsg, ServerMsg>();
  const pb = createPair<ClientMsg, ServerMsg>();
  relay.addConnection(pa.server);
  relay.addConnection(pb.server);
  const A = new Client("A", pa.client);
  const B = new Client("B", pb.client);
  return { relay, A, B, pa, pb };
}

// Simulate concurrency: both offline, edit, reconnect, resync.
function concurrently(
  pa: Pair<ClientMsg, ServerMsg>,
  pb: Pair<ClientMsg, ServerMsg>,
  A: Client,
  B: Client,
  fa: () => void,
  fb: () => void,
) {
  pa.disconnect();
  pb.disconnect();
  fa();
  fb();
  pa.reconnect();
  pb.reconnect();
  A.resync();
  B.resync();
}

function svEqual(a: Y.Doc, b: Y.Doc): boolean {
  return Buffer.from(Y.encodeStateVector(a)).equals(Buffer.from(Y.encodeStateVector(b)));
}

describe("Cephalopod M0 convergence spike", () => {
  it("S1: concurrent edits to different paragraphs converge", () => {
    const { A, B, pa, pb, relay } = setup();
    const id = newNoteId();
    A.open(id);
    B.open(id);
    A.setBody(id, "P1\n\nP2");
    concurrently(pa, pb, A, B,
      () => A.note(id).body.insert(2, "-A"),   // edit near P1
      () => B.appendBody(id, "-B"));            // edit at end (P2)
    const body = A.note(id).body.toString();
    expect(body).toContain("-A");
    expect(body).toContain("-B");
    expect(svEqual(A.doc(id), B.doc(id))).toBe(true);
    expect(B.note(id).body.toString()).toBe(body);
  });

  it("S2: concurrent title renames converge to one deterministic value", () => {
    const { A, B, pa, pb } = setup();
    const id = newNoteId();
    A.open(id);
    B.open(id);
    concurrently(pa, pb, A, B,
      () => A.setTitle(id, "Title-A"),
      () => B.setTitle(id, "Title-B"));
    const ta = A.title(id);
    const tb = B.title(id);
    expect(ta).toBe(tb); // converged
    expect(["Title-A", "Title-B"]).toContain(ta); // LWW: exactly one winner
    expect(svEqual(A.doc(id), B.doc(id))).toBe(true);
  });

  it("S3: offline edit + reconnect loses nothing", () => {
    const { A, B, pa, pb } = setup();
    const id = newNoteId();
    A.open(id);
    B.open(id);
    A.setBody(id, "base");
    pb.disconnect();
    A.appendBody(id, "-online"); // reaches relay; B offline so dropped to B
    B.appendBody(id, "-offline"); // local to B only
    pb.reconnect();
    B.resync();
    const body = B.note(id).body.toString();
    expect(body).toContain("-online");
    expect(body).toContain("-offline");
    expect(svEqual(A.doc(id), B.doc(id))).toBe(true);
  });

  it("S4: wikilink -> derived edge + backlink in server adjacency", async () => {
    const { A, relay } = setup();
    const id = newNoteId();
    A.open(id);
    A.setTitle(id, "Note A");
    A.appendBody(id, " see [[Bee]]");
    const bee = stubId("Bee");
    const slice = await A.subscribe({ focus: [id], hops: 1 });
    expect(slice.edges).toContainEqual({ from: id, to: bee, type: null, origin: "wikilink" });
    expect(slice.nodes.find((n) => n.id === bee)?.title).toBe("Bee");
    const back = await A.query({ note: bee, kind: "backlinks" });
    expect(back.edges.map((e) => e.from)).toContain(id);
  });

  it("S5: concurrent identical explicit edge is idempotent (one edge)", () => {
    const { A, B, pa, pb, relay } = setup();
    const id = newNoteId();
    const C = newNoteId();
    A.open(id);
    B.open(id);
    concurrently(pa, pb, A, B,
      () => A.link(id, C, null),
      () => B.link(id, C, null));
    expect(A.note(id).outLinks.size).toBe(1);
    expect(B.note(id).outLinks.size).toBe(1);
    const explicit = relay.allEdges().filter((e) => e.from === id && e.to === C && e.origin === "explicit");
    expect(explicit).toHaveLength(1);
    expect(svEqual(A.doc(id), B.doc(id))).toBe(true);
  });

  it("S6: concurrent wikilink remove + add reconciles derived edges", () => {
    const { A, B, pa, pb, relay } = setup();
    const id = newNoteId();
    A.open(id);
    B.open(id);
    A.setBody(id, "see [[Bee]]");
    concurrently(pa, pb, A, B,
      () => A.removeText(id, "[[Bee]]"),
      () => B.appendBody(id, " and [[Dee]]"));
    expect(svEqual(A.doc(id), B.doc(id))).toBe(true);
    // C3: deriving over each converged body yields the same edges
    const resolve = (t: string) => stubId(t);
    const ea = deriveEdges(id, A.note(id).body.toString(), resolve);
    const eb = deriveEdges(id, B.note(id).body.toString(), resolve);
    expect(ea).toEqual(eb);
    const targets = relay.allEdges().filter((e) => e.from === id && e.origin === "wikilink").map((e) => e.to);
    expect(targets).toContain(stubId("Dee"));
    expect(targets).not.toContain(stubId("Bee"));
  });

  it("S7: lazy-neighborhood fetch is bounded, not the whole graph", async () => {
    const { A } = setup();
    const id = newNoteId();
    A.open(id);
    const others: string[] = [];
    for (let i = 0; i < 99; i++) {
      const nid = newNoteId();
      others.push(nid);
      A.open(nid); // registers an isolated node
    }
    A.link(id, others[0]);
    A.link(id, others[1]);
    A.link(id, others[2]);
    const slice = await A.subscribe({ focus: [id], hops: 1 });
    expect(slice.nodes).toHaveLength(4); // id + 3 neighbors, NOT 100
    expect(slice.nodes.length).toBeLessThan(100);
  });

  it("S8: strong convergence after a mixed concurrent sequence", () => {
    const { A, B, pa, pb, relay } = setup();
    const id = newNoteId();
    const T = newNoteId();
    A.open(id);
    B.open(id);
    A.setBody(id, "start [[Target]]");
    concurrently(pa, pb, A, B,
      () => { A.setTitle(id, "Doc"); A.appendBody(id, " more-A"); A.link(id, T, "depends_on"); },
      () => { B.appendBody(id, " more-B"); B.note(id).tags.push(["service"]); });
    // identical state vectors + identical materialized values
    expect(svEqual(A.doc(id), B.doc(id))).toBe(true);
    expect(A.note(id).body.toString()).toBe(B.note(id).body.toString());
    expect(A.title(id)).toBe(B.title(id));
    expect([...A.note(id).outLinks.keys()].sort()).toEqual([...B.note(id).outLinks.keys()].sort());
    // relay (third replica) agrees on the body too
    expect(relay.doc(id)!.getText("body").toString()).toBe(A.note(id).body.toString());
  });

  it("measurements (reported, not assertions): delta size / derive cost / scope", async () => {
    // M-size: bytes for a one-character body edit.
    const d = new Y.Doc();
    const t = d.getText("body");
    t.insert(0, "hello world this is a note body");
    const sv = Y.encodeStateVector(d);
    t.insert(5, "X");
    const deltaBytes = Y.encodeStateAsUpdate(d, sv).length;

    // M-rebuild: deriving edges for a note with 20 wikilinks.
    const body = Array.from({ length: 20 }, (_, i) => `[[N${i}]]`).join(" ");
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) deriveEdges("n_x", body, stubId);
    const deriveUs = ((performance.now() - t0) / 1000) * 1000;

    // M-load: resolve a hops:2 scope over a synthetic graph.
    const { A } = setup();
    const N = Number(process.env.CEPH_SCALE ?? 2000);
    const hub = newNoteId();
    A.open(hub);
    for (let i = 0; i < N; i++) {
      const nid = newNoteId();
      A.open(nid);
      if (i % 50 === 0) A.link(hub, nid); // sparse star
    }
    const t1 = performance.now();
    const slice = await A.subscribe({ focus: [hub], hops: 2 });
    const scopeMs = performance.now() - t1;

    console.log(
      `\n  M-size:   ${deltaBytes} bytes / 1-char edit` +
        `\n  M-derive: ${deriveUs.toFixed(1)} µs / 20-link note` +
        `\n  M-load:   ${scopeMs.toFixed(2)} ms to resolve hops:2 over ${N} nodes ` +
        `(slice=${slice.nodes.length} nodes)\n`,
    );
    expect(deltaBytes).toBeLessThan(1000);
    expect(slice.nodes.length).toBeLessThan(N); // bounded
  });
});
