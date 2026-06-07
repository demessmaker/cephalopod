// Ordered, recorded schema migrations. Replaces the ad-hoc guarded ALTERs: each
// migration runs once, in version order, inside a transaction, and is recorded in
// `schema_migrations`. To evolve the schema, append a new { version, name, up }.
import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

// v1 — consolidated baseline. Idempotent (CREATE IF NOT EXISTS + guarded ADD
// COLUMN) so it absorbs both fresh databases and any created by the pre-migration
// constructor. New migrations (v2+) can be plain run-once steps.
const baseline: Migration = {
  version: 1,
  name: "baseline",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spaces(name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS updates(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        space TEXT, note TEXT, update_blob BLOB, actor TEXT, ts INTEGER);
      CREATE INDEX IF NOT EXISTS updates_doc ON updates(space, note, seq);
      CREATE INDEX IF NOT EXISTS updates_actor ON updates(space, actor, ts);
      CREATE TABLE IF NOT EXISTS snapshots(
        space TEXT, note TEXT, seq INTEGER, state BLOB, ts INTEGER,
        PRIMARY KEY(space, note));
      CREATE TABLE IF NOT EXISTS nodes(
        space TEXT, id TEXT, title TEXT, tags TEXT, stub INTEGER,
        PRIMARY KEY(space, id));
      CREATE INDEX IF NOT EXISTS nodes_title ON nodes(space, lower(title));
      CREATE TABLE IF NOT EXISTS edges(
        space TEXT, eid TEXT, frm TEXT, dst TEXT, type TEXT, origin TEXT,
        PRIMARY KEY(space, eid));
      CREATE INDEX IF NOT EXISTS edges_from ON edges(space, frm);
      CREATE INDEX IF NOT EXISTS edges_to ON edges(space, dst);

      -- full-text search (FTS5 external-content, 03 §3)
      CREATE TABLE IF NOT EXISTS notes_search(
        rowid INTEGER PRIMARY KEY, space TEXT, id TEXT, title TEXT, body TEXT,
        UNIQUE(space, id));
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, body, content='notes_search', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes_search BEGIN
        INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes_search BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes_search BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
        INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
      END;

      -- principals / tokens / roles (05 §1–2)
      CREATE TABLE IF NOT EXISTS principals(id TEXT PRIMARY KEY, kind TEXT, name TEXT);
      CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY, principal_id TEXT, capabilities TEXT);
      CREATE TABLE IF NOT EXISTS memberships(
        space TEXT, principal_id TEXT, role TEXT, PRIMARY KEY(space, principal_id));
      CREATE TABLE IF NOT EXISTS space_settings(
        space TEXT PRIMARY KEY, agent_mode TEXT, required_facets TEXT, max_notes INTEGER, secret_scan TEXT);
      CREATE TABLE IF NOT EXISTS embeddings(space TEXT, id TEXT, vec BLOB, PRIMARY KEY(space, id));
    `);
    // reconcile databases created by an older schema that predates some columns
    const addColumn = (table: string, col: string) => {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    };
    addColumn("tokens", "capabilities TEXT");
    addColumn("space_settings", "required_facets TEXT");
    addColumn("space_settings", "max_notes INTEGER");
    addColumn("space_settings", "secret_scan TEXT");
    addColumn("snapshots", "ts INTEGER");
    addColumn("updates", "actor TEXT");
    addColumn("updates", "ts INTEGER");
  },
};

// v2 — attachments / blob store (content-addressed, per-space).
const blobs: Migration = {
  version: 2,
  name: "blobs",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS blobs(
        space TEXT, hash TEXT, type TEXT, size INTEGER, bytes BLOB, created_at INTEGER,
        PRIMARY KEY(space, hash));
    `);
  },
};

export const MIGRATIONS: Migration[] = [baseline, blobs];

/** Apply all un-applied migrations in version order. Returns versions applied. */
export function runMigrations(db: Database.Database): number[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)");
  const done = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  const applied: number[] = [];
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?,?,?)").run(m.version, m.name, Date.now());
    })();
    applied.push(m.version);
  }
  return applied;
}

/** Highest applied migration version (0 if none). */
export function schemaVersion(db: Database.Database): number {
  try {
    const r = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
    return r?.v ?? 0;
  } catch {
    return 0;
  }
}
