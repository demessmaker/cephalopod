// Vault exporter (brain -> Obsidian): the inverse of the importer. Writes every
// note in a space to a Markdown file (frontmatter + body) at <props.path>/<title>.md,
// and records a sync manifest (id -> { rel, vaultHash, brainHash }) so a later
// bidirectional sync can tell which side changed.
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { SpaceHub, NoteSnapshot } from "../hub.js";
import { serializeNote, notePath, insideVault, type SerializeOptions } from "./markdown.js";

export const hashOf = (s: string) => bytesToHex(blake3(utf8ToBytes(s)));
// Vault-side content hash for change detection: tolerate CRLF / trailing-whitespace
// churn (Windows / Obsidian rewrites) so it doesn't look like a real edit. Used only
// for the manifest's `vaultHash` (never for content integrity), so normalizing is safe.
export const vaultHashOf = (s: string) => hashOf(s.replace(/\r\n/g, "\n").replace(/\s+$/, ""));

export interface SyncManifest {
  [noteId: string]: { rel: string; vaultHash: string; brainHash: string };
}

export interface ExportOptions extends SerializeOptions {
  includeDrafts?: boolean; // export #draft notes too (default false)
  dryRun?: boolean;
}

export interface ExportReport {
  filesWritten: number;
  filesUnchanged: number;
  durationMs: number;
  warnings: string[];
}

export const syncManifestPath = (vaultPath: string) => join(vaultPath, ".cephalopod", "sync-manifest.json");
// A corrupt/truncated manifest (e.g. from an interrupted run) must not brick every
// future sync — treat it as empty (a full re-export/reconcile is safe) rather than
// throwing. Entries with a non-contained `rel` are dropped (defense-in-depth).
export const loadSyncManifest = (vaultPath: string): SyncManifest => {
  const p = syncManifestPath(vaultPath);
  if (!existsSync(p)) return {};
  let raw: SyncManifest;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
  const out: SyncManifest = {};
  for (const [id, e] of Object.entries(raw)) {
    if (e && typeof e.rel === "string" && insideVault(vaultPath, join(vaultPath, e.rel))) out[id] = e;
  }
  return out;
};
// Atomic write (temp + rename) so an interrupted run never leaves a partial file.
export const saveSyncManifest = (vaultPath: string, m: SyncManifest): void => {
  mkdirSync(join(vaultPath, ".cephalopod"), { recursive: true });
  const p = syncManifestPath(vaultPath);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameSync(tmp, p);
};

// Load every (non-stub) note in a space as a snapshot, plus an id->title map for
// link rewriting. Shared by export and sync.
export async function snapshotSpace(hub: SpaceHub, space: string, includeDrafts: boolean): Promise<{ notes: NoteSnapshot[]; idToTitle: Map<string, string> }> {
  const summaries = await hub.listNotes(space, 1_000_000, includeDrafts);
  const notes: NoteSnapshot[] = [];
  const idToTitle = new Map<string, string>();
  for (const s of summaries) {
    if (s.stub) continue;
    const snap = await hub.getNoteSnapshot(space, s.id);
    if (snap.deleted) continue;
    notes.push(snap);
    idToTitle.set(snap.id, snap.title);
  }
  return { notes, idToTitle };
}

// Assign each note a unique vault-relative path, disambiguating notes that collide on
// the same file (duplicate title in a folder) with an id fragment. Shared by export
// and sync so both agree on a note's file — otherwise sync could overwrite one note's
// file with another's (data loss).
export function assignPaths(notes: NoteSnapshot[], warnings?: string[]): Map<string, string> {
  const rels = new Map<string, string>();
  const used = new Map<string, string>(); // rel -> id
  const taken = (r: string) => used.has(r) && used.get(r) !== undefined;
  for (const snap of notes) {
    let rel = notePath(snap);
    if (used.has(rel) && used.get(rel) !== snap.id) {
      // disambiguate with a short id fragment; fall back to the full (unique) id if
      // that also collides — time-based ids share prefixes, so 3+ same-title notes
      // could otherwise clobber each other.
      let cand = rel.replace(/\.md$/, ` (${snap.id.slice(2, 8)}).md`);
      if (taken(cand) && used.get(cand) !== snap.id) cand = rel.replace(/\.md$/, ` (${snap.id}).md`);
      rel = cand;
      warnings?.push(`duplicate file path for "${snap.title}" — wrote ${rel}`);
    }
    used.set(rel, snap.id);
    rels.set(snap.id, rel);
  }
  return rels;
}

export async function exportVault(hub: SpaceHub, space: string, vaultPath: string, opts: ExportOptions = {}): Promise<ExportReport> {
  const t0 = performance.now();
  const report: ExportReport = { filesWritten: 0, filesUnchanged: 0, durationMs: 0, warnings: [] };
  const { notes, idToTitle } = await snapshotSpace(hub, space, opts.includeDrafts ?? false);
  const manifest = loadSyncManifest(vaultPath);
  const next: SyncManifest = {};
  const rels = assignPaths(notes, report.warnings);

  for (const snap of notes) {
    const rel = rels.get(snap.id)!;
    const md = serializeNote(snap, idToTitle, opts);
    const brainHash = hashOf(md);
    const full = join(vaultPath, rel);
    if (!insideVault(vaultPath, full)) {
      report.warnings.push(`refused to write "${snap.title}" outside the vault (path: ${String(snap.props.path)})`);
      continue;
    }
    const prev = manifest[snap.id];
    const unchanged = prev?.brainHash === brainHash && prev?.rel === rel && existsSync(full);
    if (unchanged) {
      report.filesUnchanged++;
      next[snap.id] = prev;
      continue;
    }
    if (!opts.dryRun) {
      mkdirSync(dirname(full), { recursive: true });
      // a note that moved folders/titles leaves a stale file — remove it (contained)
      const stale = prev && prev.rel !== rel ? join(vaultPath, prev.rel) : undefined;
      if (stale && insideVault(vaultPath, stale) && existsSync(stale)) rmSync(stale);
      writeFileSync(full, md);
    }
    report.filesWritten++;
    next[snap.id] = { rel, vaultHash: vaultHashOf(md), brainHash };
  }

  if (!opts.dryRun) saveSyncManifest(vaultPath, next);
  report.durationMs = Math.round(performance.now() - t0);
  return report;
}
