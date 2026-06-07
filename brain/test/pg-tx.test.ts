// Postgres transaction-scoping + bytea binding — the bugs PGlite (single
// connection) masks. A fake pool hands out a distinct connection per `connect()`
// and records which connection each statement ran on, proving that a transaction's
// BEGIN…COMMIT and every statement between them share ONE checked-out connection
// (not the pool's per-call connection), and that bytea params are bound as Buffer.
import { describe, it, expect } from "vitest";
import { PgStore, pgPool } from "../src/store/pg.js";

type Entry = { conn: string; sql: string; params: unknown[] };
const rowsFor = (sql: string) => (/RETURNING/.test(sql) ? [{ seq: 1 }] : []);

// A pool whose `query` (non-tx) and each `connect()` use distinct connection ids,
// so a transaction wrongly issued via `pool.query` would smear across connections.
class FakePool {
  log: Entry[] = [];
  released: string[] = [];
  private n = 0;
  constructor(private failOn?: RegExp) {}
  async query(sql: string, params: unknown[] = []) {
    this.log.push({ conn: "pool", sql, params });
    return { rows: rowsFor(sql) };
  }
  async connect() {
    const id = `c${++this.n}`;
    return {
      query: async (sql: string, params: unknown[] = []) => {
        this.log.push({ conn: id, sql, params });
        if (this.failOn?.test(sql)) throw new Error(`boom: ${sql}`);
        return { rows: rowsFor(sql) };
      },
      release: () => this.released.push(id),
    };
  }
  async end() {}
}

describe("PgStore transactions are connection-scoped (pool path)", () => {
  it("runs saveSnapshot's BEGIN/COMMIT and all statements on one checked-out connection", async () => {
    const pool = new FakePool();
    const store = new PgStore(pgPool(pool as any));
    await store.saveSnapshot("kb", "n1", new Uint8Array([1, 2, 3, 4]), 5);

    const begin = pool.log.find((e) => e.sql === "BEGIN")!;
    expect(begin.conn).toMatch(/^c/); // a dedicated connection, not "pool"
    expect(pool.log.every((e) => e.conn === begin.conn)).toBe(true); // every stmt on it
    expect(pool.log.some((e) => e.sql === "COMMIT")).toBe(true);
    expect(pool.released).toContain(begin.conn); // connection returned to the pool

    // bytea bound as Buffer (a bare Uint8Array view mis-serializes under node-postgres)
    const ins = pool.log.find((e) => e.sql.includes("INSERT INTO snapshots"))!;
    expect(Buffer.isBuffer(ins.params[3])).toBe(true);
  });

  it("replaceEdgesFrom's DELETE + INSERTs share one transaction connection", async () => {
    const pool = new FakePool();
    const store = new PgStore(pgPool(pool as any));
    await store.replaceEdgesFrom("kb", "a", [
      { from: "a", to: "b", type: "calls", origin: "explicit" },
      { from: "a", to: "c", type: null, origin: "wikilink" },
    ]);
    const txConns = new Set(pool.log.map((e) => e.conn));
    expect(txConns.size).toBe(1);
    expect([...txConns][0]).toMatch(/^c/);
    expect(pool.log.filter((e) => e.sql.includes("INSERT INTO edges"))).toHaveLength(2);
  });

  it("rolls back on the SAME connection and releases it when a statement throws", async () => {
    const pool = new FakePool(/INSERT INTO edges/);
    const store = new PgStore(pgPool(pool as any));
    await expect(store.replaceEdgesFrom("kb", "a", [{ from: "a", to: "b", type: null, origin: "explicit" }])).rejects.toThrow(/boom/);

    const txConn = pool.log.find((e) => e.sql === "BEGIN")!.conn;
    const rollback = pool.log.find((e) => e.sql === "ROLLBACK")!;
    expect(rollback.conn).toBe(txConn);
    expect(pool.log.some((e) => e.sql === "COMMIT")).toBe(false);
    expect(pool.released).toContain(txConn); // released even on failure
  });

  it("binds appendUpdate's update blob as Buffer", async () => {
    const pool = new FakePool();
    const store = new PgStore(pgPool(pool as any));
    await store.appendUpdate("kb", "n1", new Uint8Array([9, 9, 9]), "actor", 123);
    const ins = pool.log.find((e) => e.sql.includes("INSERT INTO updates"))!;
    expect(Buffer.isBuffer(ins.params[2])).toBe(true);
  });
});
