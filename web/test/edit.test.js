// Track D (live editing): the browser NoteSession (Yjs sync + awareness) and the
// textarea binding. Two sessions are wired through an in-memory relay that mimics
// the brain's handshake (sync1 -> sync2+sync1, update/awareness fan-out) so we
// exercise the exact frames the real WS server speaks.
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { NoteSession, bindTextarea } from "../src/edit.js";
import { b64enc, b64dec, diffRange, applyTextChange } from "../src/yutil.js";

// A minimal stand-in for the brain: one authoritative Y.Doc per note; relays deltas
// and awareness to a note's *other* clients (origin-skip), and answers sync1.
function fakeBrain() {
  const docs = new Map();
  const clients = [];
  const docOf = (n) => (docs.has(n) ? docs.get(n) : docs.set(n, new Y.Doc()).get(n));
  return {
    connect(note, deliver) {
      const me = { note, deliver };
      clients.push(me);
      return (msg) => {
        const doc = docOf(msg.note);
        if (msg.t === "sync1") {
          deliver({ t: "sync2", space: msg.space, note: msg.note, update: b64enc(Y.encodeStateAsUpdate(doc, b64dec(msg.sv))) });
          deliver({ t: "sync1", space: msg.space, note: msg.note, sv: b64enc(Y.encodeStateVector(doc)) });
        } else if (msg.t === "sync2" || msg.t === "update") {
          Y.applyUpdate(doc, b64dec(msg.update), "srv");
          for (const c of clients) if (c !== me && c.note === msg.note) c.deliver({ t: "update", space: msg.space, note: msg.note, update: msg.update });
        } else if (msg.t === "awareness") {
          for (const c of clients) if (c !== me && c.note === msg.note) c.deliver({ t: "awareness", space: msg.space, note: msg.note, state: msg.state });
        }
      };
    },
  };
}

function join(brain, note, user) {
  const s = new NoteSession(() => {}, { space: "kb", note, user });
  s.send = brain.connect(note, (m) => s.receive(m));
  s.start();
  return s;
}

function fakeTextarea() {
  const ls = {};
  return {
    value: "", selectionStart: 0, selectionEnd: 0,
    addEventListener: (e, f) => (ls[e] ??= []).push(f),
    removeEventListener: (e, f) => (ls[e] = (ls[e] || []).filter((x) => x !== f)),
    fire: (e) => (ls[e] || []).forEach((f) => f()),
  };
}

describe("yutil", () => {
  it("diffRange finds the smallest single-range edit", () => {
    expect(diffRange("hello", "hello")).toBeNull();
    expect(diffRange("hello", "help")).toEqual({ index: 3, remove: 2, insert: "p" });
    expect(diffRange("abc", "aXbc")).toEqual({ index: 1, remove: 0, insert: "X" });
  });
  it("diffRange never begins or ends mid surrogate-pair", () => {
    const apply = (o, n) => {
      const d = diffRange(o, n);
      const out = o.slice(0, d.index) + d.insert + o.slice(d.index + d.remove);
      const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      return { out, splitInput: lone.test(o + "|" + n), splitEdit: lone.test(d.insert) };
    };
    for (const [o, n] of [["😀", "😁"], ["a😀b", "a😀Xb"], ["x😀y", "xy"], ["", "😀😁"], ["😀😁", "😀"]]) {
      const r = apply(o, n);
      expect(r.out).toBe(n); // applying the diff reproduces newStr
      expect(r.splitEdit).toBe(false); // the inserted slice is never a lone surrogate
    }
  });
  it("b64 round-trips bytes", () => {
    const u = new Uint8Array([0, 1, 250, 99, 255]);
    expect([...b64dec(b64enc(u))]).toEqual([...u]);
  });
});

describe("collaborative NoteSession", () => {
  it("converges edits from one client to another", () => {
    const brain = fakeBrain();
    const A = join(brain, "n1", { name: "Ann" });
    const B = join(brain, "n1", { name: "Bob" });

    applyTextChange(A.body, "hello from A", "local");
    expect(B.body.toString()).toBe("hello from A");

    applyTextChange(B.body, "hello from A & B", "local");
    expect(A.body.toString()).toBe("hello from A & B");
  });

  it("converges emoji/non-BMP edits without wedging a lone surrogate", () => {
    const brain = fakeBrain();
    const A = join(brain, "emoji");
    const B = join(brain, "emoji");
    applyTextChange(A.body, "hi 😀 there", "local");
    expect(B.body.toString()).toBe("hi 😀 there");
    applyTextChange(B.body, "hi 😁 there", "local"); // swap the emoji from the other client
    expect(A.body.toString()).toBe("hi 😁 there");
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(A.body.toString())).toBe(false);
  });

  it("merges concurrent edits (CRDT, no lost writes)", () => {
    const brain = fakeBrain();
    const A = join(brain, "n2");
    const B = join(brain, "n2");
    A.body.insert(0, "AAA");
    B.body.insert(0, "BBB");
    expect(A.body.toString()).toBe(B.body.toString()); // converged
    expect(A.body.toString()).toContain("AAA");
    expect(A.body.toString()).toContain("BBB");
  });

  it("relays presence to co-editors", () => {
    const brain = fakeBrain();
    const A = join(brain, "n3", { name: "Ann", color: "#f00" });
    const B = join(brain, "n3", { name: "Bob" });
    A.setCursor(4); // an awareness change *after* wiring is what propagates

    const peers = B.peers();
    expect(peers.some((p) => p.name === "Ann" && p.color === "#f00")).toBe(true);
    expect(B.doc.clientID === A.doc.clientID).toBe(false);
  });
});

describe("bindTextarea", () => {
  it("pushes local typing into the doc and reflects remote edits", () => {
    const brain = fakeBrain();
    const A = join(brain, "n4");
    const B = join(brain, "n4");
    const elA = fakeTextarea(), elB = fakeTextarea();
    bindTextarea(A, elA);
    bindTextarea(B, elB);

    // type in A's textarea -> B's textarea updates
    elA.value = "shared text";
    elA.fire("input");
    expect(A.body.toString()).toBe("shared text");
    expect(elB.value).toBe("shared text");

    // edit in B -> A reflects it
    elB.value = "shared text!";
    elB.fire("input");
    expect(elA.value).toBe("shared text!");
  });
});
