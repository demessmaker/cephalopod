// Minimal shared core (mirrors brain/src/core) — the arm needs note schema, ids,
// and the wire protocol to talk to the brain relay.
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export function edgeId(from: string, to: string, type: string | null): string {
  return "e_" + bytesToHex(blake3(utf8ToBytes(`${from}→${to}::${type ?? ""}`))).slice(0, 24);
}
export function newNoteId(): string {
  return "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
