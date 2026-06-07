// Postgres-backed store (AsyncStore). The multi-tenant / scale target behind the
// same contract as SqliteStore. Tested in-process via PGlite (real Postgres in
// WASM); in production point it at a pooled `pg` connection (adapter below).
//
// Embeddings are stored as bytea and scored in JS (parity with SQLite); at scale
// you'd add the `vector` extension + an ANN index. FTS uses native tsvector.
import { edgeId } from "../core/ids.js";
import { dot } from "../embedder.js";
import type { NodeSummary } from "../core/protocol.js";
import type { EdgeRec } from "../core/wikilinks.js";
import type { AsyncStore, LoadedDoc, LoadedDocMeta, Principal, Role, Snapshot } from "./store.js";

export interface PgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  exec?(sql: string): Promise<unknown>; // multi-statement (PGlite); optional
  close?(): Promise<void> | void;
}

const toU8 = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBufferLike));
const toF32 = (v: unknown): Float32Array => {
  const u = toU8(v);
  return new Float32Array(new Uint8Array(u).buffer); // copy -> 4-byte aligned
};
const likeTag = (t: string) => `%"${t}"%`;

export class PgStore implements AsyncStore {
  constructor(private db: PgClient) {}
  private q(sql: string, params: unknown[] = []) {
    return this.db.query(sql, params);
  }
  private async one<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.q(sql, params)).rows[0];
  }

  // Run the schema. Idempotent (CREATE IF NOT EXISTS). Call once after construction.
  async init(): Promise<void> {
    const run = (sql: string) => (this.db.exec ? this.db.exec(sql) : this.db.query(sql));
    await run(`
      CREATE TABLE IF NOT EXISTS spaces(name text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS updates(
        seq bigserial PRIMARY KEY, space text, note text, update_blob bytea, actor text, ts bigint);
      CREATE INDEX IF NOT EXISTS updates_doc ON updates(space, note, seq);
      CREATE INDEX IF NOT EXISTS updates_actor ON updates(space, actor, ts);
      CREATE TABLE IF NOT EXISTS snapshots(
        space text, note text, seq bigint, state bytea, ts bigint, PRIMARY KEY(space, note));
      CREATE TABLE IF NOT EXISTS nodes(
        ord bigserial, space text, id text, title text, tags text, stub int, PRIMARY KEY(space, id));
      CREATE INDEX IF NOT EXISTS nodes_title ON nodes(space, lower(title));
      CREATE TABLE IF NOT EXISTS edges(
        space text, eid text, frm text, dst text, type text, origin text, PRIMARY KEY(space, eid));
      CREATE INDEX IF NOT EXISTS edges_from ON edges(space, frm);
      CREATE INDEX IF NOT EXISTS edges_to ON edges(space, dst);
      CREATE TABLE IF NOT EXISTS notes_search(space text, id text, title text, body text, PRIMARY KEY(space, id));
      CREATE INDEX IF NOT EXISTS notes_tsv ON notes_search
        USING gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,'')));
      CREATE TABLE IF NOT EXISTS principals(id text PRIMARY KEY, kind text, name text);
      CREATE TABLE IF NOT EXISTS tokens(hash text PRIMARY KEY, principal_id text, capabilities text);
      CREATE TABLE IF NOT EXISTS memberships(space text, principal_id text, role text, PRIMARY KEY(space, principal_id));
      CREATE TABLE IF NOT EXISTS space_settings(
        space text PRIMARY KEY, agent_mode text, required_facets text, max_notes int, secret_scan text);
      CREATE TABLE IF NOT EXISTS embeddings(space text, id text, vec bytea, PRIMARY KEY(space, id));
    `);
  }

  async ensureSpace(space: string): Promise<void> {
    await this.q("INSERT INTO spaces(name) VALUES ($1) ON CONFLICT DO NOTHING", [space]);
  }
  async listSpaces(): Promise<string[]> {
    return (await this.q("SELECT name FROM spaces ORDER BY name")).rows.map((r) => r.name);
  }

  // --- log + snapshots ---
  async appendUpdate(space: string, note: string, update: Uint8Array, actor: string, ts: number): Promise<number> {
    await this.ensureSpace(space);
    const r = await this.one("INSERT INTO updates(space, note, update_blob, actor, ts) VALUES ($1,$2,$3,$4,$5) RETURNING seq", [
      space, note, update, actor, ts,
    ]);
    return Number(r.seq);
  }
  async loadDoc(space: string, note: string): Promise<LoadedDoc> {
    const snap = await this.one("SELECT seq, state, ts FROM snapshots WHERE space=$1 AND note=$2", [space, note]);
    const since = snap ? Number(snap.seq) : 0;
    const rows = (await this.q("SELECT update_blob FROM updates WHERE space=$1 AND note=$2 AND seq>$3 ORDER BY seq", [space, note, since])).rows;
    const snapshot: Snapshot | undefined = snap ? { seq: Number(snap.seq), state: toU8(snap.state), coversTs: Number(snap.ts ?? 0) } : undefined;
    return { snapshot, updates: rows.map((r) => toU8(r.update_blob)) };
  }
  async loadDocMeta(space: string, note: string): Promise<LoadedDocMeta> {
    const snap = await this.one("SELECT seq, state, ts FROM snapshots WHERE space=$1 AND note=$2", [space, note]);
    const since = snap ? Number(snap.seq) : 0;
    const rows = (await this.q("SELECT actor, ts, update_blob FROM updates WHERE space=$1 AND note=$2 AND seq>$3 ORDER BY seq", [space, note, since])).rows;
    return {
      snapshot: snap ? { seq: Number(snap.seq), state: toU8(snap.state), coversTs: Number(snap.ts ?? 0) } : undefined,
      updates: rows.map((r) => ({ actor: r.actor ?? "", ts: Number(r.ts ?? 0), bytes: toU8(r.update_blob) })),
    };
  }
  async notesTouchedBy(space: string, actor: string, sinceTs: number): Promise<string[]> {
    return (await this.q("SELECT DISTINCT note FROM updates WHERE space=$1 AND actor=$2 AND ts>=$3", [space, actor, sinceTs])).rows.map((r) => r.note);
  }
  async saveSnapshot(space: string, note: string, state: Uint8Array, seq: number): Promise<void> {
    await this.q("BEGIN");
    try {
      const folded = Number((await this.one("SELECT MAX(ts) AS m FROM updates WHERE space=$1 AND note=$2 AND seq<=$3", [space, note, seq]))?.m ?? 0);
      const prev = Number((await this.one("SELECT ts FROM snapshots WHERE space=$1 AND note=$2", [space, note]))?.ts ?? 0);
      const coversTs = Math.max(folded, prev);
      await this.q(
        `INSERT INTO snapshots(space, note, seq, state, ts) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT(space, note) DO UPDATE SET seq=excluded.seq, state=excluded.state, ts=excluded.ts`,
        [space, note, seq, state, coversTs],
      );
      await this.q("DELETE FROM updates WHERE space=$1 AND note=$2 AND seq<=$3", [space, note, seq]);
      await this.q("COMMIT");
    } catch (e) {
      await this.q("ROLLBACK");
      throw e;
    }
  }

  // --- derived index ---
  async upsertNode(space: string, n: NodeSummary): Promise<void> {
    await this.q(
      `INSERT INTO nodes(space, id, title, tags, stub) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT(space, id) DO UPDATE SET title=excluded.title, tags=excluded.tags, stub=excluded.stub`,
      [space, n.id, n.title, JSON.stringify(n.tags), n.stub ? 1 : 0],
    );
  }
  async deleteNode(space: string, id: string): Promise<void> {
    await this.q("DELETE FROM nodes WHERE space=$1 AND id=$2", [space, id]);
  }
  async getNode(space: string, id: string): Promise<NodeSummary | undefined> {
    const r = await this.one("SELECT id, title, tags, stub FROM nodes WHERE space=$1 AND id=$2", [space, id]);
    return r ? { id: r.id, title: r.title, tags: JSON.parse(r.tags), stub: !!r.stub } : undefined;
  }
  async listNodes(space: string, limit: number, includeDrafts: boolean, tagFilters: string[] = []): Promise<NodeSummary[]> {
    const where = ["space=$1", "stub=0"];
    const params: unknown[] = [space];
    if (!includeDrafts) where.push(`tags NOT LIKE '%"draft"%'`);
    for (const t of tagFilters) { params.push(likeTag(t)); where.push(`tags LIKE $${params.length}`); }
    params.push(limit);
    const rows = (await this.q(`SELECT id, title, tags, stub FROM nodes WHERE ${where.join(" AND ")} ORDER BY ord DESC LIMIT $${params.length}`, params)).rows;
    return rows.map((r) => ({ id: r.id, title: r.title, tags: JSON.parse(r.tags), stub: !!r.stub }));
  }
  async findIdByTitle(space: string, titleLower: string): Promise<string | undefined> {
    return (await this.one("SELECT id FROM nodes WHERE space=$1 AND lower(title)=$2 AND stub=0 LIMIT 1", [space, titleLower]))?.id;
  }
  async replaceEdgesFrom(space: string, from: string, edges: EdgeRec[]): Promise<void> {
    await this.q("BEGIN");
    try {
      await this.q("DELETE FROM edges WHERE space=$1 AND frm=$2", [space, from]);
      for (const e of edges) {
        await this.q(
          `INSERT INTO edges(space, eid, frm, dst, type, origin) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT(space, eid) DO UPDATE SET frm=excluded.frm, dst=excluded.dst, type=excluded.type, origin=excluded.origin`,
          [space, edgeId(e.from, e.to, e.type), e.from, e.to, e.type, e.origin],
        );
      }
      await this.q("COMMIT");
    } catch (e) {
      await this.q("ROLLBACK");
      throw e;
    }
  }
  async edgesAdjacent(space: string, id: string, dir: "out" | "in" | "both"): Promise<EdgeRec[]> {
    const map = (r: any): EdgeRec => ({ from: r.frm, to: r.dst, type: r.type, origin: r.origin });
    const out: EdgeRec[] = [];
    if (dir === "out" || dir === "both")
      out.push(...(await this.q("SELECT frm, dst, type, origin FROM edges WHERE space=$1 AND frm=$2", [space, id])).rows.map(map));
    if (dir === "in" || dir === "both")
      out.push(...(await this.q("SELECT frm, dst, type, origin FROM edges WHERE space=$1 AND dst=$2", [space, id])).rows.map(map));
    return out;
  }

  // --- full-text search ---
  async searchUpsert(space: string, id: string, title: string, body: string): Promise<void> {
    await this.q(
      `INSERT INTO notes_search(space, id, title, body) VALUES ($1,$2,$3,$4)
       ON CONFLICT(space, id) DO UPDATE SET title=excluded.title, body=excluded.body`,
      [space, id, title, body],
    );
  }
  async searchDelete(space: string, id: string): Promise<void> {
    await this.q("DELETE FROM notes_search WHERE space=$1 AND id=$2", [space, id]);
  }
  async search(space: string, query: string, limit: number, includeDrafts: boolean, tagFilters: string[] = []): Promise<string[]> {
    if (!query.trim()) return [];
    const params: unknown[] = [space, query];
    const where = ["s.space=$1", "to_tsvector('english', coalesce(s.title,'') || ' ' || coalesce(s.body,'')) @@ plainto_tsquery('english',$2)"];
    if (!includeDrafts) where.push(`n.tags NOT LIKE '%"draft"%'`);
    for (const t of tagFilters) { params.push(likeTag(t)); where.push(`n.tags LIKE $${params.length}`); }
    params.push(limit);
    const sql = `SELECT s.id AS id FROM notes_search s JOIN nodes n ON n.space=s.space AND n.id=s.id
       WHERE ${where.join(" AND ")}
       ORDER BY ts_rank(to_tsvector('english', coalesce(s.title,'') || ' ' || coalesce(s.body,'')), plainto_tsquery('english',$2)) DESC
       LIMIT $${params.length}`;
    return (await this.q(sql, params)).rows.map((r) => r.id);
  }
  async tagCounts(space: string): Promise<{ tag: string; count: number }[]> {
    const rows = (await this.q("SELECT tags FROM nodes WHERE space=$1 AND stub=0", [space])).rows;
    const counts = new Map<string, number>();
    for (const r of rows) for (const t of JSON.parse(r.tags) as string[]) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
  }

  // --- vector ---
  async upsertEmbedding(space: string, id: string, vec: Float32Array): Promise<void> {
    const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
    await this.q(`INSERT INTO embeddings(space, id, vec) VALUES ($1,$2,$3) ON CONFLICT(space, id) DO UPDATE SET vec=excluded.vec`, [space, id, bytes]);
  }
  async deleteEmbedding(space: string, id: string): Promise<void> {
    await this.q("DELETE FROM embeddings WHERE space=$1 AND id=$2", [space, id]);
  }
  async searchSemantic(space: string, query: Float32Array, limit: number, includeDrafts: boolean): Promise<string[]> {
    const draft = includeDrafts ? "" : `AND n.tags NOT LIKE '%"draft"%'`;
    const rows = (await this.q(
      `SELECT e.id AS id, e.vec AS vec FROM embeddings e JOIN nodes n ON n.space=e.space AND n.id=e.id WHERE e.space=$1 AND n.stub=0 ${draft}`,
      [space],
    )).rows;
    return rows
      .map((r) => ({ id: r.id, score: dot(query, toF32(r.vec)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.id);
  }

  // --- principals / tokens / roles ---
  async addPrincipal(p: Principal): Promise<void> {
    await this.q("INSERT INTO principals(id, kind, name) VALUES ($1,$2,$3) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name", [p.id, p.kind, p.name]);
  }
  async getPrincipal(id: string): Promise<Principal | undefined> {
    const r = await this.one("SELECT id, kind, name FROM principals WHERE id=$1", [id]);
    return r ? { id: r.id, kind: r.kind, name: r.name } : undefined;
  }
  async addToken(hash: string, principalId: string, capabilities: string): Promise<void> {
    await this.q("INSERT INTO tokens(hash, principal_id, capabilities) VALUES ($1,$2,$3) ON CONFLICT(hash) DO UPDATE SET principal_id=excluded.principal_id, capabilities=excluded.capabilities", [hash, principalId, capabilities]);
  }
  async principalIdByToken(hash: string): Promise<string | undefined> {
    return (await this.one("SELECT principal_id FROM tokens WHERE hash=$1", [hash]))?.principal_id;
  }
  async getCapabilities(hash: string): Promise<string | undefined> {
    return (await this.one("SELECT capabilities FROM tokens WHERE hash=$1", [hash]))?.capabilities ?? undefined;
  }
  async principalCount(): Promise<number> {
    return Number((await this.one("SELECT COUNT(*) AS c FROM principals"))?.c ?? 0);
  }
  async setRole(space: string, principalId: string, role: Role): Promise<void> {
    await this.q("INSERT INTO memberships(space, principal_id, role) VALUES ($1,$2,$3) ON CONFLICT(space, principal_id) DO UPDATE SET role=excluded.role", [space, principalId, role]);
  }
  async getRole(space: string, principalId: string): Promise<Role | undefined> {
    return (await this.one("SELECT role FROM memberships WHERE space=$1 AND principal_id=$2", [space, principalId]))?.role;
  }
  async listMemberships(principalId: string): Promise<{ space: string; role: Role }[]> {
    return (await this.q("SELECT space, role FROM memberships WHERE principal_id=$1", [principalId])).rows.map((r) => ({ space: r.space, role: r.role }));
  }

  // --- settings ---
  private async upsertSetting(space: string, col: string, val: unknown): Promise<void> {
    await this.q(`INSERT INTO space_settings(space, ${col}) VALUES ($1,$2) ON CONFLICT(space) DO UPDATE SET ${col}=excluded.${col}`, [space, val]);
  }
  async getAgentMode(space: string): Promise<"draft" | "open"> {
    return (await this.one("SELECT agent_mode FROM space_settings WHERE space=$1", [space]))?.agent_mode === "open" ? "open" : "draft";
  }
  setAgentMode(space: string, mode: "draft" | "open"): Promise<void> {
    return this.upsertSetting(space, "agent_mode", mode);
  }
  async getRequiredFacets(space: string): Promise<string[]> {
    const r = await this.one("SELECT required_facets FROM space_settings WHERE space=$1", [space]);
    return r?.required_facets ? JSON.parse(r.required_facets) : [];
  }
  setRequiredFacets(space: string, facets: string[]): Promise<void> {
    return this.upsertSetting(space, "required_facets", JSON.stringify(facets));
  }
  async getMaxNotes(space: string): Promise<number> {
    return Number((await this.one("SELECT max_notes FROM space_settings WHERE space=$1", [space]))?.max_notes ?? 0);
  }
  setMaxNotes(space: string, max: number): Promise<void> {
    return this.upsertSetting(space, "max_notes", max);
  }
  async countNotes(space: string): Promise<number> {
    return Number((await this.one("SELECT COUNT(*) AS c FROM nodes WHERE space=$1 AND stub=0", [space]))?.c ?? 0);
  }
  async getSecretScan(space: string): Promise<"off" | "warn" | "block"> {
    const v = (await this.one("SELECT secret_scan FROM space_settings WHERE space=$1", [space]))?.secret_scan;
    return v === "off" || v === "block" ? v : "warn";
  }
  setSecretScan(space: string, mode: "off" | "warn" | "block"): Promise<void> {
    return this.upsertSetting(space, "secret_scan", mode);
  }

  async purgeNote(space: string, id: string): Promise<void> {
    await this.q("BEGIN");
    try {
      for (const sql of [
        "DELETE FROM updates WHERE space=$1 AND note=$2",
        "DELETE FROM snapshots WHERE space=$1 AND note=$2",
        "DELETE FROM nodes WHERE space=$1 AND id=$2",
        "DELETE FROM notes_search WHERE space=$1 AND id=$2",
        "DELETE FROM embeddings WHERE space=$1 AND id=$2",
      ]) await this.q(sql, [space, id]);
      await this.q("DELETE FROM edges WHERE space=$1 AND (frm=$2 OR dst=$2)", [space, id]);
      await this.q("COMMIT");
    } catch (e) {
      await this.q("ROLLBACK");
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.db.close?.();
  }
}

// Adapter for production `pg` (node-postgres). Usage:
//   import { Pool } from "pg";
//   const store = new PgStore(pgPool(new Pool({ connectionString: process.env.DATABASE_URL })));
//   await store.init();
// (Tests use PGlite directly, which already satisfies PgClient.)
export function pgPool(pool: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>; end(): Promise<void> }): PgClient {
  return {
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    close: () => pool.end(),
  };
}
