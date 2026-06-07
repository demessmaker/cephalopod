// M1 acceptance: durability (log), restart rehydration, snapshot compaction,
// and per-space isolation.
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { stubId } from "../src/core/ids.js";
import { TestClient, makeNote, liveNote } from "./helpers.js";
import { b64 } from "../src/core/protocol.js";

const tmps: string[] = [];
function tmpDb(): string {
  const p = join(tmpdir(), `ceph-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tmps.push(p);
  return p;
}
afterEach(() => {
  for (const p of tmps.splice(0)) for (const s of ["", "-wal", "-shm"]) try { rmSync(p + s); } catch {}
});

describe("M1 brain — persistence", () => {
  it("log + restart rehydrates doc state and the derived index", async () => {
    const db = tmpDb();
    // --- session 1: write a note, then "crash" (close store) ---
    {
      const store = new SqliteStore(db);
      const hub = new SpaceHub(store, { snapshotEvery: 1000 }); // force pure-log path
      const c = new TestClient();
      hub.addConnection(c.conn);
      await c.applyNote("sp", "n_1", makeNote("n_1", { title: "Alpha", body: "see [[Beta]]" }));
      expect((await hub.docState("sp", "n_1")).getText("body").toString()).toBe("see [[Beta]]");
      store.close();
    }
    // --- session 2: fresh process on the same db file ---
    {
      const store = new SqliteStore(db);
      const hub = new SpaceHub(store);
      const c = new TestClient();
      hub.addConnection(c.conn);
      // derived index survived WITHOUT loading the doc:
      const scope = await c.query("sp", { note: "n_1", kind: "neighbors", hops: 1 });
      expect(scope.edges).toContainEqual({ from: "n_1", to: stubId("Beta"), type: null, origin: "wikilink" });
      // doc body rehydrates from the log:
      await c.open("sp", "n_1");
      expect((await hub.docState("sp", "n_1")).getText("body").toString()).toBe("see [[Beta]]");
      store.close();
    }
  });

  it("snapshots compact the log and still rehydrate", async () => {
    const db = tmpDb();
    {
      const store = new SqliteStore(db);
      const hub = new SpaceHub(store, { snapshotEvery: 3 });
      const c = new TestClient();
      hub.addConnection(c.conn);
      const ln = liveNote("n_x");
      ln.h.meta.set("title", "Doc"); // u0
      ln.h.body.insert(0, "a");       // u1
      ln.h.body.insert(1, "b");       // u2  -> snapshot taken here (every 3)
      ln.h.body.insert(2, "c");       // u3
      ln.h.body.insert(3, "d");       // u4
      c.send({ t: "open", space: "sp", note: "n_x" });
      for (const u of ln.updates) c.send({ t: "update", space: "sp", note: "n_x", update: b64.enc(u) });
      await c.drain("sp");
      // a snapshot exists and the log tail is compacted to the post-snapshot updates
      const loaded = store.loadDoc("sp", "n_x");
      expect(loaded.snapshot).toBeDefined();
      expect(loaded.updates.length).toBe(2); // only u3,u4 remain after compaction
      store.close();
    }
    {
      const store = new SqliteStore(db);
      const hub = new SpaceHub(store);
      const c = new TestClient();
      hub.addConnection(c.conn);
      await c.open("sp", "n_x");
      expect((await hub.docState("sp", "n_x")).getText("body").toString()).toBe("abcd");
      store.close();
    }
  });

  it("spaces are isolated", async () => {
    const store = new SqliteStore(":memory:");
    const hub = new SpaceHub(store);
    const c = new TestClient();
    hub.addConnection(c.conn);
    await c.applyNote("teamA", "n_1", makeNote("n_1", { title: "A-title" }));
    await c.applyNote("teamB", "n_1", makeNote("n_1", { title: "B-title" }));
    const a = await c.query("teamA", { note: "n_1", kind: "neighbors", hops: 1 });
    const b = await c.query("teamB", { note: "n_1", kind: "neighbors", hops: 1 });
    expect(a.nodes.find((n) => n.id === "n_1")?.title).toBe("A-title");
    expect(b.nodes.find((n) => n.id === "n_1")?.title).toBe("B-title");
    expect(store.listSpaces().sort()).toEqual(["teamA", "teamB"]);
    store.close();
  });
});
