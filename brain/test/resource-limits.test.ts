// Resource-exhaustion guards: a self-bounding rate-limiter map, per-principal WS
// message rate limiting, and an LRU cap on resident in-memory docs.
import { describe, it, expect } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub, type ConnAuth } from "../src/hub.js";
import { RateLimiter } from "../src/ratelimit.js";
import type { Conn, ClientMsg, ServerMsg } from "../src/core/protocol.js";

function fakeConn() {
  const sent: ServerMsg[] = [];
  let cb: (m: ClientMsg) => void = () => {};
  const ch: Conn<ServerMsg, ClientMsg> = { send: (m) => sent.push(m), onMessage: (f) => (cb = f) };
  return { ch, sent, recv: (m: ClientMsg) => cb(m) };
}
const ALLOW = (principalId: string): ConnAuth => ({ canRead: () => true, canWrite: () => true, principalId });

describe("RateLimiter is self-bounding", () => {
  it("still rate-limits per key", () => {
    const rl = new RateLimiter(3, 0); // burst 3, no refill
    expect([rl.allow("a", 0), rl.allow("a", 0), rl.allow("a", 0), rl.allow("a", 0)]).toEqual([true, true, true, false]);
  });

  it("drops buckets for keys that have gone idle (no unbounded growth)", () => {
    const rl = new RateLimiter(5, 5); // refills to full in 1s
    for (let i = 0; i < 1000; i++) rl.allow(`k${i}`, 0); // all active now -> retained
    expect(rl.size).toBeGreaterThan(0);
    for (let i = 0; i < 1000; i++) rl.allow(`k${i}`, 10_000); // long idle -> fully refilled -> dropped
    expect(rl.size).toBe(0);
  });
});

describe("per-principal WS rate limiting", () => {
  it("limits a flood of messages from one principal", () => {
    const hub = new SpaceHub(new SqliteStore(":memory:"), { rateLimit: { capacity: 3, refillPerSec: 0 } });
    const f = fakeConn();
    hub.addConnection(f.ch, ALLOW("p1"));
    for (let i = 0; i < 10; i++) f.recv({ t: "open", space: "kb", note: `n_${i}` });
    const limited = f.sent.filter((m) => m.t === "error" && m.code === "rate_limited");
    expect(limited).toHaveLength(7); // 3 allowed, 7 limited
  });

  it("limits are per-principal, not shared across principals", () => {
    const hub = new SpaceHub(new SqliteStore(":memory:"), { rateLimit: { capacity: 2, refillPerSec: 0 } });
    const a = fakeConn(), b = fakeConn();
    hub.addConnection(a.ch, ALLOW("pa"));
    hub.addConnection(b.ch, ALLOW("pb"));
    for (let i = 0; i < 3; i++) a.recv({ t: "open", space: "kb", note: `a_${i}` });
    expect(a.sent.filter((m) => m.t === "error")).toHaveLength(1);
    // pb has its own fresh budget
    b.recv({ t: "open", space: "kb", note: "b_0" });
    b.recv({ t: "open", space: "kb", note: "b_1" });
    expect(b.sent.filter((m) => m.t === "error")).toHaveLength(0);
  });
});

describe("resident docs are LRU-bounded", () => {
  it("evicts cold docs beyond the cap but keeps data retrievable", () => {
    const hub = new SpaceHub(new SqliteStore(":memory:"), { maxLoadedDocs: 5 });
    for (let i = 0; i < 30; i++) hub.createNote("kb", { title: `T${i}`, body: `body ${i}` }, `n_${i}`);

    // never holds more than the cap in memory
    expect((hub as any).docs.size).toBeLessThanOrEqual(5);

    // an evicted note rehydrates from snapshot+log on access
    expect(hub.getNoteSnapshot("kb", "n_0").title).toBe("T0");
    expect(hub.getNoteSnapshot("kb", "n_15").body).toBe("body 15");
    // search still finds evicted content (derived index is durable)
    expect(hub.search("kb", "body").length).toBeGreaterThan(0);
  });
});
