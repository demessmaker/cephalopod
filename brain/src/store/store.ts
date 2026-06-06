// Persistence interface for the brain (04 §2.3, §4): the authoritative
// append-only update log + materialized snapshots, plus the *derived* graph
// index (nodes/edges) used for traversal without loading note docs.
import type { NodeSummary } from "../core/protocol.js";
import type { EdgeRec } from "../core/wikilinks.js";

export type Role = "viewer" | "editor" | "admin";

export interface Principal {
  id: string;
  kind: "user" | "agent";
  name: string;
}

export interface Snapshot {
  seq: number;
  state: Uint8Array;
}

export interface LoadedDoc {
  snapshot?: Snapshot;
  updates: Uint8Array[]; // tail with seq > snapshot.seq, in order
}

export interface MetaUpdate {
  actor: string;
  ts: number;
  bytes: Uint8Array;
}
export interface LoadedDocMeta {
  snapshot?: Snapshot;
  updates: MetaUpdate[];
}

export interface Store {
  ensureSpace(space: string): void;
  listSpaces(): string[];

  // --- authoritative log + snapshots (per note doc) ---
  appendUpdate(space: string, note: string, update: Uint8Array, actor: string, ts: number): number; // -> seq
  loadDoc(space: string, note: string): LoadedDoc;
  loadDocMeta(space: string, note: string): LoadedDocMeta; // tail with actor/ts (for revert)
  notesTouchedBy(space: string, actor: string, sinceTs: number): string[];
  saveSnapshot(space: string, note: string, state: Uint8Array, seq: number): void;

  // --- derived graph index (rebuildable) ---
  upsertNode(space: string, n: NodeSummary): void;
  deleteNode(space: string, id: string): void;
  getNode(space: string, id: string): NodeSummary | undefined;
  listNodes(space: string, limit: number, includeDrafts: boolean, tagFilters: string[]): NodeSummary[];
  findIdByTitle(space: string, titleLower: string): string | undefined;
  replaceEdgesFrom(space: string, from: string, edges: EdgeRec[]): void;
  edgesAdjacent(space: string, id: string, dir: "out" | "in" | "both"): EdgeRec[];

  // --- full-text search (FTS5) + tags ---
  searchUpsert(space: string, id: string, title: string, body: string): void;
  searchDelete(space: string, id: string): void;
  search(space: string, query: string, limit: number, includeDrafts: boolean, tagFilters: string[]): string[]; // ranked ids
  tagCounts(space: string): { tag: string; count: number }[];

  // --- vector / semantic search (03 §3) ---
  upsertEmbedding(space: string, id: string, vec: Float32Array): void;
  deleteEmbedding(space: string, id: string): void;
  searchSemantic(space: string, query: Float32Array, limit: number, includeDrafts: boolean): string[]; // ranked ids

  // --- per-space settings ---
  getAgentMode(space: string): "draft" | "open"; // 05 §4 agent write policy
  setAgentMode(space: string, mode: "draft" | "open"): void;
  getRequiredFacets(space: string): string[]; // required tag-key facets (e.g. client, project)
  setRequiredFacets(space: string, facets: string[]): void;
  getMaxNotes(space: string): number; // per-space note quota (0 = unlimited)
  setMaxNotes(space: string, max: number): void;
  countNotes(space: string): number; // non-stub notes
  getSecretScan(space: string): "off" | "warn" | "block";
  setSecretScan(space: string, mode: "off" | "warn" | "block"): void;

  // --- destructive admin op (05 §5) ---
  purgeNote(space: string, id: string): void; // expunge from log, snapshots, index, search, embeddings

  // --- principals, tokens, roles (05 §1–2) ---
  addPrincipal(p: Principal): void;
  getPrincipal(id: string): Principal | undefined;
  addToken(hash: string, principalId: string, capabilities: string): void;
  principalIdByToken(hash: string): string | undefined;
  getCapabilities(hash: string): string | undefined; // raw JSON, or undefined
  principalCount(): number;
  setRole(space: string, principalId: string, role: Role): void;
  getRole(space: string, principalId: string): Role | undefined;
  listMemberships(principalId: string): { space: string; role: Role }[];

  close(): void;
}
