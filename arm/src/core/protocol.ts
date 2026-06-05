export type B64 = string;
export interface NodeSummary { id: string; title: string; tags: string[]; stub: boolean }
export interface EdgeRec { from: string; to: string; type: string | null; origin: string }

export type ClientMsg =
  | { t: "open"; space: string; note: string }
  | { t: "sync1"; space: string; note: string; sv: B64 }
  | { t: "sync2"; space: string; note: string; update: B64 }
  | { t: "update"; space: string; note: string; update: B64 };

export type ServerMsg =
  | { t: "sync1"; space: string; note: string; sv: B64 }
  | { t: "sync2"; space: string; note: string; update: B64 }
  | { t: "update"; space: string; note: string; update: B64 }
  | { t: "error"; code: string; message: string };

export const b64 = {
  enc: (u: Uint8Array): B64 => Buffer.from(u).toString("base64"),
  dec: (s: B64): Uint8Array => new Uint8Array(Buffer.from(s, "base64")),
};
