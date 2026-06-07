// Vault exporter (brain -> Obsidian): the inverse of the importer. Writes every
// note in a space to a Markdown file (frontmatter + body) at <props.path>/<title>.md,
// and records a sync manifest (id -> { rel, vaultHash, brainHash }) so a later
// bidirectional sync can tell which side changed.
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { SpaceHub, NoteSnapshot } from "../hub.js";
import { serializeNote, notePath, type SerializeOptions } from "./markdown.js";

export const hashOf = (s: string) => bytesToHex(blake3(utf8ToBytes(s)));

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
export const loadSyncManifest = (vaultPath: string): SyncManifest => {
  const p = syncManifestPath(vaultPath);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
};
export const saveSyncManifest = (vaultPath: string, m: SyncManifest): void => {
  mkdirSync(join(vaultPath, ".cephalopod"), { recursive: true });
  writeFileSync(syncManifestPath(vaultPath), JSON.stringify(m, null, 2));
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

export async function exportVault(hub: SpaceHub, space: string, vaultPath: string, opts: ExportOptions = {}): Promise<ExportReport> {
  const t0 = performance.now();
  const report: ExportReport = { filesWritten: 0, filesUnchanged: 0, durationMs: 0, warnings: [] };
  const { notes, idToTitle } = await snapshotSpace(hub, space, opts.includeDrafts ?? false);
  const manifest = loadSyncManifest(vaultPath);
  const next: SyncManifest = {};

  // Guard against two notes mapping to the same file (duplicate titles in a folder).
  const usedRel = new Map<string, string>();
  for (const snap of notes) {
    let rel = notePath(snap);
    const clash = usedRel.get(rel);
    if (clash && clash !== snap.id) {
      rel = rel.replace(/\.md$/, ` (${snap.id.slice(2, 8)}).md`); // disambiguate by id fragment
      report.warnings.push(`duplicate file path for "${snap.title}" — wrote ${rel}`);
    }
    usedRel.set(rel, snap.id);

    const md = serializeNote(snap, idToTitle, opts);
    const brainHash = hashOf(md);
    const full = join(vaultPath, rel);
    const prev = manifest[snap.id];
    const unchanged = prev?.brainHash === brainHash && prev?.rel === rel && existsSync(full);
    if (unchanged) {
      report.filesUnchanged++;
      next[snap.id] = prev;
      continue;
    }
    if (!opts.dryRun) {
      mkdirSync(dirname(full), { recursive: true });
      // a note that moved folders/titles leaves a stale file — remove it
      if (prev && prev.rel !== rel && existsSync(join(vaultPath, prev.rel))) rmSync(join(vaultPath, prev.rel));
      writeFileSync(full, md);
    }
    report.filesWritten++;
    next[snap.id] = { rel, vaultHash: hashOf(md), brainHash };
  }

  if (!opts.dryRun) saveSyncManifest(vaultPath, next);
  report.durationMs = Math.round(performance.now() - t0);
  return report;
}
