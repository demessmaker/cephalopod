// Bidirectional Obsidian sync. Reconciles a space against a vault using a content
// -hash manifest (id -> { rel, vaultHash, brainHash }): for each note we ask "did
// the vault file change since last sync?" and "did the brain note change since last
// sync?" and apply the side that moved. When BOTH moved it's a conflict, resolved
// by a configurable policy (default: brain wins, the vault's version preserved in a
// `.conflict.md` sidecar and the note tagged `sync-conflict`) — never lossy.
import { readdirSync, lstatSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, sep, dirname, basename } from "node:path";
import type { SpaceHub, NoteSnapshot, NoteFields } from "../hub.js";
import { parseFrontmatter, withCephalopodId } from "./frontmatter.js";
import { serializeNote, asTags, notePath, insideVault, type SerializeOptions } from "./markdown.js";
import { hashOf, loadSyncManifest, saveSyncManifest, snapshotSpace, type SyncManifest } from "./export.js";

export interface SyncOptions extends SerializeOptions {
  includeDrafts?: boolean;
  conflict?: "brain" | "vault"; // who wins when both sides changed (default: brain)
  writeBack?: boolean; // inject cephalopod_id into new vault files (default true)
  exclude?: string[];
  dryRun?: boolean;
}

export interface SyncReport {
  imported: number; // vault -> brain (created or updated)
  exported: number; // brain -> vault (created or updated)
  conflicts: string[]; // note ids that diverged on both sides
  unchanged: number;
  durationMs: number;
  warnings: string[];
}

interface VaultFile { rel: string; full: string; content: string; body: string; data: Record<string, unknown>; hash: string; title: string; id?: string }

const pathId = (rel: string) => "n_" + hashOf("obsidian:" + rel).slice(0, 20);

function walk(dir: string, exclude: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (exclude.some((e) => full.includes(e))) continue;
    const st = lstatSync(full); // lstat: don't follow symlinks out of the vault
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(full, exclude, out);
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

// A vault file -> note fields. Bodies stay title-form; the brain's reindex resolves
// wikilinks (and mints stubs) on its own, so we don't rewrite links to id-form here.
function fileToFields(f: VaultFile): NoteFields {
  const { cephalopod_id, tags, aliases, ...rest } = f.data;
  const props: Record<string, unknown> = { ...rest, path: dirname(f.rel) === "." ? "" : dirname(f.rel), authoredBy: "human" };
  if (aliases) props.aliases = asTags(aliases);
  return { title: f.title, body: f.body, tags: asTags(tags), props };
}

export async function syncVault(hub: SpaceHub, space: string, vaultPath: string, opts: SyncOptions = {}): Promise<SyncReport> {
  const t0 = performance.now();
  const conflictPolicy = opts.conflict ?? "brain";
  const writeBack = opts.writeBack ?? true;
  const exclude = [".obsidian", ".cephalopod", ".conflict.md", ...(opts.exclude ?? [])];
  const report: SyncReport = { imported: 0, exported: 0, conflicts: [], unchanged: 0, durationMs: 0, warnings: [] };
  await hub.ensureSpaceExists(space);

  const manifest = loadSyncManifest(vaultPath);
  const relToId = new Map<string, string>();
  for (const [id, m] of Object.entries(manifest)) relToId.set(m.rel, id);

  // ---- gather vault files (by id) ----
  const vaultById = new Map<string, VaultFile>();
  for (const full of existsSync(vaultPath) ? walk(vaultPath, exclude) : []) {
    const rel = relative(vaultPath, full).split(sep).join("/");
    const content = readFileSync(full, "utf8");
    const { data, body } = parseFrontmatter(content);
    const title = basename(full, ".md");
    const id = (typeof data.cephalopod_id === "string" ? data.cephalopod_id : undefined) ?? relToId.get(rel) ?? pathId(rel);
    vaultById.set(id, { rel, full, content, body, data, hash: hashOf(content), title, id });
  }

  // ---- gather brain notes (by id) + id->title for link rewriting ----
  const { notes, idToTitle } = await snapshotSpace(hub, space, opts.includeDrafts ?? false);
  const brainById = new Map<string, NoteSnapshot>();
  for (const n of notes) brainById.set(n.id, n);

  const next: SyncManifest = {};
  const ids = new Set([...brainById.keys(), ...vaultById.keys()]);

  for (const id of ids) {
    const v = vaultById.get(id);
    const b = brainById.get(id);
    const prev = manifest[id];
    const brainMd = b ? serializeNote(b, idToTitle, opts) : undefined;
    const brainHash = brainMd ? hashOf(brainMd) : undefined;
    const vaultChanged = v ? v.hash !== prev?.vaultHash : false;
    const brainChanged = b ? brainHash !== prev?.brainHash : false;

    // both present
    if (v && b) {
      if (vaultChanged && brainChanged) {
        report.conflicts.push(id);
        if (conflictPolicy === "vault") {
          if (!opts.dryRun) await applyToBrain(hub, space, b, v, true);
          report.imported++;
          next[id] = await remanifest(hub, space, id, v.rel, v.content, idToTitle, opts);
        } else {
          // brain wins: preserve the vault's divergent copy, overwrite the file.
          // The sidecar goes under .cephalopod/conflicts/ (excluded from walk) so it
          // isn't re-imported as a duplicate note on the next sync.
          if (!opts.dryRun) {
            const sidecar = join(vaultPath, ".cephalopod", "conflicts", v.rel);
            if (insideVault(vaultPath, sidecar)) {
              mkdirSync(dirname(sidecar), { recursive: true });
              writeFileSync(sidecar, v.content);
            }
            if (insideVault(vaultPath, v.full)) writeFileSync(v.full, brainMd!);
            await tagConflict(hub, space, b);
          }
          report.exported++;
          report.warnings.push(`conflict on "${b.title}" — brain kept, vault copy in ${basename(v.rel).replace(/\.md$/, ".conflict.md")}`);
          next[id] = { rel: v.rel, vaultHash: hashOf(brainMd!), brainHash: brainHash! };
        }
      } else if (vaultChanged) {
        if (!opts.dryRun) await applyToBrain(hub, space, b, v, false);
        report.imported++;
        next[id] = await remanifest(hub, space, id, v.rel, v.content, idToTitle, opts);
      } else if (brainChanged) {
        const rel = notePath(b);
        if (!opts.dryRun) writeFile(vaultPath, rel, brainMd!, prev?.rel, v.rel);
        report.exported++;
        next[id] = { rel, vaultHash: hashOf(brainMd!), brainHash: brainHash! };
      } else {
        report.unchanged++;
        next[id] = prev ?? { rel: v.rel, vaultHash: v.hash, brainHash: brainHash! };
      }
      continue;
    }

    // vault-only: a file whose note doesn't exist (new file, or note was purged) -> create/update in brain
    if (v && !b) {
      const isNew = typeof v.data.cephalopod_id !== "string";
      const finalContent = writeBack && isNew ? withCephalopodId(v.content, id) : v.content;
      if (!opts.dryRun) {
        const fields = fileToFields(v);
        if (await hub.hasNote(space, id)) await hub.patchNote(space, id, fields);
        else await hub.createNote(space, fields, id);
        if (writeBack && isNew && insideVault(vaultPath, v.full)) writeFileSync(v.full, finalContent);
      }
      report.imported++;
      next[id] = await remanifest(hub, space, id, v.rel, finalContent, idToTitle, opts);
      continue;
    }

    // brain-only: a note with no vault file (new note, or file deleted) -> write the file
    if (b && !v) {
      const rel = notePath(b);
      if (!opts.dryRun) writeFile(vaultPath, rel, brainMd!, prev?.rel, undefined);
      report.exported++;
      next[id] = { rel, vaultHash: hashOf(brainMd!), brainHash: brainHash! };
    }
  }

  if (!opts.dryRun) saveSyncManifest(vaultPath, next);
  report.durationMs = Math.round(performance.now() - t0);
  return report;
}

function writeFile(vaultPath: string, rel: string, md: string, prevRel: string | undefined, vaultRel: string | undefined): void {
  const full = join(vaultPath, rel);
  if (!insideVault(vaultPath, full)) return; // contained: never write outside the vault
  mkdirSync(dirname(full), { recursive: true });
  // clean up a stale file the note moved away from (contained)
  for (const stale of [prevRel, vaultRel]) {
    if (!stale || stale === rel) continue;
    const sf = join(vaultPath, stale);
    if (insideVault(vaultPath, sf) && existsSync(sf)) rmSync(sf);
  }
  writeFileSync(full, md);
}

async function applyToBrain(hub: SpaceHub, space: string, b: NoteSnapshot, v: VaultFile, _conflict: boolean): Promise<void> {
  const fields = fileToFields(v);
  if (await hub.hasNote(space, b.id)) await hub.patchNote(space, b.id, fields);
  else await hub.createNote(space, fields, b.id);
}

async function tagConflict(hub: SpaceHub, space: string, b: NoteSnapshot): Promise<void> {
  if (b.tags.includes("sync-conflict")) return;
  await hub.patchNote(space, b.id, { tags: [...b.tags, "sync-conflict"] });
}

// Recompute the manifest entry after an import: brainHash from the note's actual
// post-import serialization, vaultHash from the file's current on-disk content. The
// two are tracked independently — they differ in formatting, but each must match its
// own side next time or we'd loop re-detecting a phantom change.
async function remanifest(hub: SpaceHub, space: string, id: string, rel: string, finalVaultContent: string, idToTitle: Map<string, string>, opts: SyncOptions): Promise<{ rel: string; vaultHash: string; brainHash: string }> {
  const snap = await hub.getNoteSnapshot(space, id);
  idToTitle.set(id, snap.title);
  const md = serializeNote(snap, idToTitle, opts);
  return { rel, vaultHash: hashOf(finalVaultContent), brainHash: hashOf(md) };
}
