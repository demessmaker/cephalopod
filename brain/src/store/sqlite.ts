// SQLite store — the durable default for self-host-first v1 (04 §6). A Postgres
// implementation of the same `Store` interface is the multi-tenant target later;
// nothing above this file knows which backend is in use.
import Database from "better-sqlite3";
import { edgeId } from "../core/ids.js";
import { dot } from "../embedder.js";
import type { NodeSummary } from "../core/protocol.js";
import type { EdgeRec } from "../core/wikilinks.js";
import type { LoadedDoc, Snapshot, Store } from "./store.js";

const buf = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

export class SqliteStore implements Store {
  private db: Database.Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spaces(name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS updates(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        space TEXT, note TEXT, update_blob BLOB);
      CREATE INDEX IF NOT EXISTS updates_doc ON updates(space, note, seq);
      CREATE TABLE IF NOT EXISTS snapshots(
        space TEXT, note TEXT, seq INTEGER, state BLOB,
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
      CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY, principal_id TEXT);
      CREATE TABLE IF NOT EXISTS memberships(
        space TEXT, principal_id TEXT, role TEXT, PRIMARY KEY(space, principal_id));
      CREATE TABLE IF NOT EXISTS space_settings(space TEXT PRIMARY KEY, agent_mode TEXT);
      CREATE TABLE IF NOT EXISTS embeddings(space TEXT, id TEXT, vec BLOB, PRIMARY KEY(space, id));
    `);
  }

  ensureSpace(space: string): void {
    this.db.prepare("INSERT OR IGNORE INTO spaces(name) VALUES (?)").run(space);
  }
  listSpaces(): string[] {
    return this.db.prepare("SELECT name FROM spaces ORDER BY name").all().map((r: any) => r.name);
  }

  appendUpdate(space: string, note: string, update: Uint8Array): number {
    this.ensureSpace(space);
    const info = this.db
      .prepare("INSERT INTO updates(space, note, update_blob) VALUES (?,?,?)")
      .run(space, note, buf(update));
    return Number(info.lastInsertRowid);
  }

  loadDoc(space: string, note: string): LoadedDoc {
    const snap = this.db
      .prepare("SELECT seq, state FROM snapshots WHERE space=? AND note=?")
      .get(space, note) as { seq: number; state: Buffer } | undefined;
    const since = snap ? snap.seq : 0;
    const rows = this.db
      .prepare("SELECT update_blob FROM updates WHERE space=? AND note=? AND seq>? ORDER BY seq")
      .all(space, note, since) as { update_blob: Buffer }[];
    const snapshot: Snapshot | undefined = snap ? { seq: snap.seq, state: u8(snap.state) } : undefined;
    return { snapshot, updates: rows.map((r) => u8(r.update_blob)) };
  }

  saveSnapshot(space: string, note: string, state: Uint8Array, seq: number): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO snapshots(space, note, seq, state) VALUES (?,?,?,?)
           ON CONFLICT(space, note) DO UPDATE SET seq=excluded.seq, state=excluded.state`,
        )
        .run(space, note, seq, buf(state));
      // compaction: superseded log entries are now redundant (retention = OQ-3)
      this.db.prepare("DELETE FROM updates WHERE space=? AND note=? AND seq<=?").run(space, note, seq);
    });
    tx();
  }

  upsertNode(space: string, n: NodeSummary): void {
    this.db
      .prepare(
        `INSERT INTO nodes(space, id, title, tags, stub) VALUES (?,?,?,?,?)
         ON CONFLICT(space, id) DO UPDATE SET title=excluded.title, tags=excluded.tags, stub=excluded.stub`,
      )
      .run(space, n.id, n.title, JSON.stringify(n.tags), n.stub ? 1 : 0);
  }
  deleteNode(space: string, id: string): void {
    this.db.prepare("DELETE FROM nodes WHERE space=? AND id=?").run(space, id);
  }
  getNode(space: string, id: string): NodeSummary | undefined {
    const r = this.db.prepare("SELECT id, title, tags, stub FROM nodes WHERE space=? AND id=?").get(space, id) as any;
    return r ? { id: r.id, title: r.title, tags: JSON.parse(r.tags), stub: !!r.stub } : undefined;
  }
  listNodes(space: string, limit: number, includeDrafts: boolean): NodeSummary[] {
    const draftClause = includeDrafts ? "" : `AND tags NOT LIKE '%"draft"%'`;
    return (
      this.db
        .prepare(`SELECT id, title, tags, stub FROM nodes WHERE space=? AND stub=0 ${draftClause} ORDER BY rowid DESC LIMIT ?`)
        .all(space, limit) as any[]
    ).map((r) => ({ id: r.id, title: r.title, tags: JSON.parse(r.tags), stub: !!r.stub }));
  }
  findIdByTitle(space: string, titleLower: string): string | undefined {
    const r = this.db
      .prepare("SELECT id FROM nodes WHERE space=? AND lower(title)=? AND stub=0 LIMIT 1")
      .get(space, titleLower) as any;
    return r?.id;
  }

  replaceEdgesFrom(space: string, from: string, edges: EdgeRec[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM edges WHERE space=? AND frm=?").run(space, from);
      const ins = this.db.prepare(
        "INSERT OR REPLACE INTO edges(space, eid, frm, dst, type, origin) VALUES (?,?,?,?,?,?)",
      );
      for (const e of edges) ins.run(space, edgeId(e.from, e.to, e.type), e.from, e.to, e.type, e.origin);
    });
    tx();
  }

  edgesAdjacent(space: string, id: string, dir: "out" | "in" | "both"): EdgeRec[] {
    const map = (r: any): EdgeRec => ({ from: r.frm, to: r.dst, type: r.type, origin: r.origin });
    const out: EdgeRec[] = [];
    if (dir === "out" || dir === "both") {
      out.push(...(this.db.prepare("SELECT frm, dst, type, origin FROM edges WHERE space=? AND frm=?").all(space, id) as any[]).map(map));
    }
    if (dir === "in" || dir === "both") {
      out.push(...(this.db.prepare("SELECT frm, dst, type, origin FROM edges WHERE space=? AND dst=?").all(space, id) as any[]).map(map));
    }
    return out;
  }

  // --- full-text search + tags ---
  searchUpsert(space: string, id: string, title: string, body: string): void {
    this.db
      .prepare(
        `INSERT INTO notes_search(space, id, title, body) VALUES (?,?,?,?)
         ON CONFLICT(space, id) DO UPDATE SET title=excluded.title, body=excluded.body`,
      )
      .run(space, id, title, body);
  }
  searchDelete(space: string, id: string): void {
    this.db.prepare("DELETE FROM notes_search WHERE space=? AND id=?").run(space, id);
  }
  search(space: string, query: string, limit: number, includeDrafts: boolean): string[] {
    // exclude #draft notes from discovery unless asked (05 §4)
    const draftClause = includeDrafts ? "" : `AND n.tags NOT LIKE '%"draft"%'`;
    return (
      this.db
        .prepare(
          `SELECT s.id AS id FROM notes_fts f
             JOIN notes_search s ON s.rowid=f.rowid
             JOIN nodes n ON n.space=s.space AND n.id=s.id
           WHERE notes_fts MATCH ? AND s.space=? ${draftClause} ORDER BY rank LIMIT ?`,
        )
        .all(query, space, limit) as any[]
    ).map((r) => r.id);
  }
  upsertEmbedding(space: string, id: string, vec: Float32Array): void {
    const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db
      .prepare(`INSERT INTO embeddings(space, id, vec) VALUES (?,?,?) ON CONFLICT(space, id) DO UPDATE SET vec=excluded.vec`)
      .run(space, id, blob);
  }
  deleteEmbedding(space: string, id: string): void {
    this.db.prepare("DELETE FROM embeddings WHERE space=? AND id=?").run(space, id);
  }
  searchSemantic(space: string, query: Float32Array, limit: number, includeDrafts: boolean): string[] {
    const draftClause = includeDrafts ? "" : `AND n.tags NOT LIKE '%"draft"%'`;
    const rows = this.db
      .prepare(
        `SELECT e.id AS id, e.vec AS vec FROM embeddings e
           JOIN nodes n ON n.space=e.space AND n.id=e.id
         WHERE e.space=? AND n.stub=0 ${draftClause}`,
      )
      .all(space) as { id: string; vec: Buffer }[];
    const scored = rows.map((r) => {
      const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
      return { id: r.id, score: dot(query, v) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.id);
  }

  tagCounts(space: string): { tag: string; count: number }[] {
    const rows = this.db.prepare("SELECT tags FROM nodes WHERE space=? AND stub=0").all(space) as any[];
    const counts = new Map<string, number>();
    for (const r of rows) for (const t of JSON.parse(r.tags) as string[]) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
  }

  // --- principals / tokens / roles ---
  addPrincipal(p: { id: string; kind: "user" | "agent"; name: string }): void {
    this.db.prepare("INSERT OR REPLACE INTO principals(id, kind, name) VALUES (?,?,?)").run(p.id, p.kind, p.name);
  }
  getPrincipal(id: string) {
    const r = this.db.prepare("SELECT id, kind, name FROM principals WHERE id=?").get(id) as any;
    return r ? { id: r.id, kind: r.kind, name: r.name } : undefined;
  }
  addToken(hash: string, principalId: string): void {
    this.db.prepare("INSERT OR REPLACE INTO tokens(hash, principal_id) VALUES (?,?)").run(hash, principalId);
  }
  principalIdByToken(hash: string): string | undefined {
    const r = this.db.prepare("SELECT principal_id FROM tokens WHERE hash=?").get(hash) as any;
    return r?.principal_id;
  }
  principalCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM principals").get() as any).c;
  }
  setRole(space: string, principalId: string, role: "viewer" | "editor" | "admin"): void {
    this.db
      .prepare(
        `INSERT INTO memberships(space, principal_id, role) VALUES (?,?,?)
         ON CONFLICT(space, principal_id) DO UPDATE SET role=excluded.role`,
      )
      .run(space, principalId, role);
  }
  getRole(space: string, principalId: string) {
    const r = this.db.prepare("SELECT role FROM memberships WHERE space=? AND principal_id=?").get(space, principalId) as any;
    return r?.role;
  }
  listMemberships(principalId: string) {
    return (this.db.prepare("SELECT space, role FROM memberships WHERE principal_id=?").all(principalId) as any[]).map(
      (r) => ({ space: r.space, role: r.role }),
    );
  }

  getAgentMode(space: string): "draft" | "open" {
    const r = this.db.prepare("SELECT agent_mode FROM space_settings WHERE space=?").get(space) as any;
    return r?.agent_mode === "open" ? "open" : "draft"; // draft-gate by default
  }
  setAgentMode(space: string, mode: "draft" | "open"): void {
    this.db
      .prepare(
        `INSERT INTO space_settings(space, agent_mode) VALUES (?,?)
         ON CONFLICT(space) DO UPDATE SET agent_mode=excluded.agent_mode`,
      )
      .run(space, mode);
  }

  close(): void {
    this.db.close();
  }
}
