// C2: relay horizontal sharding. Two SpaceHub instances share one store and one
// fan-out bus (standing in for NATS/Redis across processes). A delta committed on
// hub A must reach a live connection attached to hub B — and B's in-memory cache
// must converge to A's content — without B re-persisting or re-broadcasting.
import { describe, it, expect } from "vitest";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub, ALLOW_ALL } from "../src/hub.js";
import { LocalBus } from "../src/broadcast.js";
import type { Conn, ClientMsg, ServerMsg } from "../src/core/protocol.js";

function fakeConn() {
  const sent: ServerMsg[] = [];
  let cb: (m: ClientMsg) => void = () => {};
  const ch: Conn<ServerMsg, ClientMsg> = { send: (m) => sent.push(m), onMessage: (f) => (cb = f) };
  return { ch, sent, recv: (m: ClientMsg) => cb(m) };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("cross-instance fan-out (relay sharding)", () => {
  it("a write on hub A reaches a subscribed connection on hub B", async () => {
    const store = new SqliteStore(":memory:"); // single shared store (== one Postgres)
    const bus = new LocalBus();
    const hubA = new SpaceHub(store, { broadcaster: bus.connect("A") });
    const hubB = new SpaceHub(store, { broadcaster: bus.connect("B") });

    await hubA.createNote("kb", { title: "Shared", body: "v1" }, "n_1");

    // a live reader attached to hub B opens the note
    const reader = fakeConn();
    const conn = hubB.addConnection(reader.ch, ALLOW_ALL);
    reader.recv({ t: "open", space: "kb", note: "n_1" });
    await conn.tail;

    // a writer edits the note on hub A
    await hubA.patchNote("kb", "n_1", { body: "v2 from A" });
    await settle(); // let the bus deliver to B

    // B fanned the delta out to its local reader …
    expect(reader.sent.filter((m) => m.t === "update" && m.note === "n_1").length).toBeGreaterThan(0);
    // … and B's resident doc converged to A's content
    expect((await hubB.getNoteSnapshot("kb", "n_1")).body).toBe("v2 from A");
  });

  it("does not echo a hub's own publishes back to itself (no loop)", async () => {
    const store = new SqliteStore(":memory:");
    const bus = new LocalBus();
    const hubA = new SpaceHub(store, { broadcaster: bus.connect("A") });

    // a reader on the SAME hub that writes — it must receive the normal local
    // fan-out exactly once, not a duplicate from the self-published broadcast.
    const reader = fakeConn();
    const conn = hubA.addConnection(reader.ch, ALLOW_ALL);
    await hubA.createNote("kb", { title: "Solo", body: "x" }, "n_2");
    reader.recv({ t: "open", space: "kb", note: "n_2" });
    await conn.tail;

    await hubA.patchNote("kb", "n_2", { body: "edited" });
    await settle();

    expect(reader.sent.filter((m) => m.t === "update" && m.note === "n_2")).toHaveLength(1);
  });

  it("a single hub with no broadcaster behaves exactly as before", async () => {
    const hub = new SpaceHub(new SqliteStore(":memory:")); // no broadcaster
    await hub.createNote("kb", { title: "Local", body: "only" }, "n_3");
    await hub.patchNote("kb", "n_3", { body: "changed" });
    expect((await hub.getNoteSnapshot("kb", "n_3")).body).toBe("changed");
  });
});
