// Schema migrations: ordered, recorded, idempotent, and able to upgrade a DB
// created by the pre-migration (ad-hoc) schema.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, schemaVersion, MIGRATIONS } from "../src/store/migrations.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { Auth } from "../src/auth.js";

const latest = Math.max(...MIGRATIONS.map((m) => m.version));

describe("schema migrations", () => {
  it("applies all migrations on a fresh DB and records them", () => {
    const db = new Database(":memory:");
    const applied = runMigrations(db);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(schemaVersion(db)).toBe(latest);
    const rows = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    expect(rows.length).toBe(MIGRATIONS.length);
    db.close();
  });

  it("is idempotent: a second run applies nothing", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(runMigrations(db)).toEqual([]); // nothing left to do
    expect(schemaVersion(db)).toBe(latest);
    db.close();
  });

  it("upgrades a legacy DB (ad-hoc schema, no schema_migrations table)", () => {
    // simulate an old DB: core tables but missing later columns and no version table
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE spaces(name TEXT PRIMARY KEY);
      CREATE TABLE tokens(hash TEXT PRIMARY KEY, principal_id TEXT);
      CREATE TABLE space_settings(space TEXT PRIMARY KEY, agent_mode TEXT);
    `);
    const applied = runMigrations(db);
    expect(applied).toContain(1);
    // the previously-missing columns now exist
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
    expect(cols("tokens")).toContain("capabilities");
    expect(cols("space_settings")).toEqual(expect.arrayContaining(["required_facets", "max_notes", "secret_scan"]));
    db.close();
  });

  it("a SqliteStore built on the runner is fully functional", () => {
    const store = new SqliteStore(":memory:");
    const auth = new Auth(store);
    const p = auth.createPrincipal("user", "x");
    const tok = auth.issueToken(p.id, { mode: "read" });
    expect(auth.authenticate(tok)?.id).toBe(p.id);
    expect(auth.capabilities(tok).mode).toBe("read"); // capabilities column present
    store.close();
  });
});
