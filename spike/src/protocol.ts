// §6 — wire protocol. JSON messages; Yjs binary carried as base64.
import type { EdgeRec } from "./wikilinks.js";

export type B64 = string;

export interface NodeSummary {
  id: string;
  title: string;
  tags: string[];
  stub: boolean;
}

export interface Scope {
  focus: string[];
  hops: number;
  dir?: "out" | "in" | "both";
}

export interface GraphQuery {
  note: string;
  kind: "neighbors" | "backlinks";
  hops?: number;
  dir?: "out" | "in" | "both";
}

export type ClientMsg =
  | { t: "subscribe"; id: string; scope: Scope }
  | { t: "open"; note: string }
  | { t: "sync1"; note: string; sv: B64 }
  | { t: "sync2"; note: string; update: B64 }
  | { t: "update"; note: string; update: B64 }
  | { t: "query"; id: string; q: GraphQuery };

export type ServerMsg =
  | { t: "slice"; id: string; nodes: NodeSummary[]; edges: EdgeRec[] }
  | { t: "sync1"; note: string; sv: B64 }
  | { t: "sync2"; note: string; update: B64 }
  | { t: "update"; note: string; update: B64 }
  | { t: "result"; id: string; nodes: NodeSummary[]; edges: EdgeRec[] };

// A transport-agnostic duplex channel. mem + ws both implement this.
export interface Conn<TSend, TRecv> {
  send(msg: TSend): void;
  onMessage(cb: (msg: TRecv) => void): void;
}

export const b64 = {
  enc: (u: Uint8Array): B64 => Buffer.from(u).toString("base64"),
  dec: (s: B64): Uint8Array => new Uint8Array(Buffer.from(s, "base64")),
};
