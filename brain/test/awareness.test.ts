// Track D (live editing): ephemeral presence relay. Awareness frames are fanned to
// the *other* watchers of the same note, never persisted, and exempt from the
// write-path rate limit (cursor moves are frequent).
import { describe, it, expect } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub, type ConnAuth } from "../src/hub.js";
import type { Conn, ClientMsg, ServerMsg } from "../src/core/protocol.js";

function fakeConn() {
  const sent: ServerMsg[] = [];
  let cb: (m: ClientMsg) => void = () => {};
  const ch: Conn<ServerMsg, ClientMsg> = { send: (m) => sent.push(m), onMessage: (f) => (cb = f) };
  return { ch, sent, recv: (m: ClientMsg) => cb(m) };
}
const ALLOW = (principalId: string): ConnAuth => ({ canRead: () => true, canWrite: () => true, principalId });

describe("awareness/presence relay", () => {
  it("fans presence to co-watchers of the same note only, and never persists it", async () => {
    const store = new SqliteStore(":memory:");
    const hub = new SpaceHub(store);
    const a = fakeConn(), b = fakeConn(), c = fakeConn();
    const ca = hub.addConnection(a.ch, ALLOW("a"));
    const cb = hub.addConnection(b.ch, ALLOW("b"));
    const cc = hub.addConnection(c.ch, ALLOW("c"));
    // A and B watch n_1; C watches a different note
    a.recv({ t: "open", space: "kb", note: "n_1" });
    b.recv({ t: "open", space: "kb", note: "n_1" });
    c.recv({ t: "open", space: "kb", note: "n_2" });
    await Promise.all([ca.tail, cb.tail, cc.tail]);

    a.recv({ t: "awareness", space: "kb", note: "n_1", state: "Y3Vyc29y" });
    await ca.tail;

    const presence = (f: typeof b) => f.sent.filter((m) => m.t === "awareness");
    expect(presence(b)).toHaveLength(1); // co-watcher gets it
    expect((presence(b)[0] as any).state).toBe("Y3Vyc29y");
    expect(presence(a)).toHaveLength(0); // not echoed to sender
    expect(presence(c)).toHaveLength(0); // not a watcher of n_1

    // ephemeral: nothing was written for n_1 (no node, no log)
    expect(await hub.hasNote("kb", "n_1")).toBe(false);
  });

  it("is exempt from the per-principal message rate limit", async () => {
    const hub = new SpaceHub(new SqliteStore(":memory:"), { rateLimit: { capacity: 2, refillPerSec: 0 } });
    const a = fakeConn(), b = fakeConn();
    const ca = hub.addConnection(a.ch, ALLOW("a"));
    hub.addConnection(b.ch, ALLOW("b"));
    a.recv({ t: "open", space: "kb", note: "n_1" });
    b.recv({ t: "open", space: "kb", note: "n_1" });
    await ca.tail;

    // a burst of presence well beyond the bucket — none rejected
    for (let i = 0; i < 20; i++) a.recv({ t: "awareness", space: "kb", note: "n_1", state: `s${i}` });
    await ca.tail;

    expect(a.sent.filter((m) => m.t === "error" && (m as any).code === "rate_limited")).toHaveLength(0);
    expect(b.sent.filter((m) => m.t === "awareness").length).toBe(20);
  });
});
