// Persistence interface for the brain (04 §2.3, §4): the authoritative
// append-only update log + materialized snapshots, plus the *derived* graph
// index (nodes/edges) used for traversal without loading note docs.
import type { NodeSummary } from "../core/protocol.js";
import type { EdgeRec } from "../core/wikilinks.js";

export interface Snapshot {
  seq: number;
  state: Uint8Array;
}

export interface LoadedDoc {
  snapshot?: Snapshot;
  updates: Uint8Array[]; // tail with seq > snapshot.seq, in order
}

export interface Store {
  ensureSpace(space: string): void;
  listSpaces(): string[];

  // --- authoritative log + snapshots (per note doc) ---
  appendUpdate(space: string, note: string, update: Uint8Array): number; // -> seq
  loadDoc(space: string, note: string): LoadedDoc;
  saveSnapshot(space: string, note: string, state: Uint8Array, seq: number): void;

  // --- derived graph index (rebuildable) ---
  upsertNode(space: string, n: NodeSummary): void;
  deleteNode(space: string, id: string): void;
  getNode(space: string, id: string): NodeSummary | undefined;
  findIdByTitle(space: string, titleLower: string): string | undefined;
  replaceEdgesFrom(space: string, from: string, edges: EdgeRec[]): void;
  edgesAdjacent(space: string, id: string, dir: "out" | "in" | "both"): EdgeRec[];

  close(): void;
}
