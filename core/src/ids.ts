// Identity helpers (graduated from the M0 spike, 01 §2.3).
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

// Deterministic edge id: same logical edge -> same id on every replica.
export function edgeId(from: string, to: string, type: string | null): string {
  return "e_" + bytesToHex(blake3(utf8ToBytes(`${from}→${to}::${type ?? ""}`))).slice(0, 24);
}

export function newNoteId(): string {
  return "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Deterministic stub id from a title (01 §2.2): independent replicas derive the
// same target for an unresolved [[wikilink]].
export function stubId(title: string): string {
  return "n_stub_" + bytesToHex(blake3(utf8ToBytes("stub:" + title.toLowerCase()))).slice(0, 16);
}
