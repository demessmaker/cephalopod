// Wire protocol (M1: every message is scoped to a space).
import type { EdgeRec } from "./wikilinks.js";
export type { EdgeRec } from "./wikilinks.js"; // re-export so clients can import it here

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
  | { t: "subscribe"; id: string; space: string; scope: Scope }
  | { t: "open"; space: string; note: string }
  | { t: "sync1"; space: string; note: string; sv: B64 }
  | { t: "sync2"; space: string; note: string; update: B64 }
  | { t: "update"; space: string; note: string; update: B64 }
  | { t: "query"; id: string; space: string; q: GraphQuery };

export type ServerMsg =
  | { t: "slice"; id: string; nodes: NodeSummary[]; edges: EdgeRec[] }
  | { t: "sync1"; space: string; note: string; sv: B64 }
  | { t: "sync2"; space: string; note: string; update: B64 }
  | { t: "update"; space: string; note: string; update: B64 }
  | { t: "result"; id: string; nodes: NodeSummary[]; edges: EdgeRec[] }
  | { t: "error"; code: string; message: string; ref?: string };

export interface Conn<TSend, TRecv> {
  send(msg: TSend): void;
  onMessage(cb: (msg: TRecv) => void): void;
}

export const b64 = {
  enc: (u: Uint8Array): B64 => Buffer.from(u).toString("base64"),
  dec: (s: B64): Uint8Array => new Uint8Array(Buffer.from(s, "base64")),
};

export const docKey = (space: string, note: string) => `${space} ${note}`;
