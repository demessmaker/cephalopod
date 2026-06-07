// Obsidian vault importer (spec 08). Two-pass, idempotent, in-process bulk import
// through the brain's write path. Maps files->notes, [[wikilinks]]->edges,
// frontmatter->tags/props, ![[embeds]]->embeds edges / attachment refs.
import { readdirSync, lstatSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, sep, basename, extname } from "node:path";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { SpaceHub } from "../hub.js";
import { parseFrontmatter, withCephalopodId } from "./frontmatter.js";

export interface ImportOptions {
  writeBack?: boolean; // inject cephalopod_id into files (default true)
  update?: "skip" | "merge" | "overwrite"; // for already-imported notes (default merge)
  keepTitles?: boolean; // don't rewrite [[Title]] -> [[id|Title]]
  attachments?: "link" | "skip" | "upload"; // link (default), skip, or upload to the blob store
  exclude?: string[]; // path fragments to skip
  dryRun?: boolean;
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
  webp: "image/webp", pdf: "application/pdf", mp4: "video/mp4", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", zip: "application/zip",
};
const mimeOf = (name: string) => MIME[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";

// All files under a dir (not just .md) — used to locate attachments for upload.
function walkAll(dir: string, exclude: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (exclude.some((e) => full.includes(e))) continue;
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walkAll(full, exclude, out);
    else out.push(full);
  }
  return out;
}

export interface ImportReport {
  notesCreated: number;
  notesUpdated: number;
  notesSkipped: number;
  wikilinkEdges: number;
  embedEdges: number;
  stubs: number;
  attachments: number;
  warnings: string[];
  durationMs: number;
}

interface Manifest {
  [relpath: string]: { id: string; hash: string };
}

const IMG = /\.(png|jpe?g|gif|svg|webp|pdf|mp4|mov|mp3|wav|zip)$/i;
const hash = (s: string) => bytesToHex(blake3(utf8ToBytes(s)));
const pathId = (rel: string) => "n_" + hash("obsidian:" + rel).slice(0, 20);

function walk(dir: string, exclude: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (exclude.some((e) => full.includes(e))) continue;
    const st = lstatSync(full); // lstat, not stat: don't follow symlinks
    if (st.isSymbolicLink()) continue; // a symlink could point outside the vault — skip it
    if (st.isDirectory()) walk(full, exclude, out);
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

function asTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).replace(/^#/, ""));
  if (typeof v === "string") return v.split(/[\s,]+/).map((x) => x.replace(/^#/, "")).filter(Boolean);
  return [];
}

// !?[[ type:: target #anchor | alias ]]
const LINK = /(!?)\[\[\s*(?:([\w-]+)::\s*)?([^\]|#]+?)\s*(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

export async function importVault(hub: SpaceHub, space: string, vaultPath: string, opts: ImportOptions = {}): Promise<ImportReport> {
  const t0 = performance.now();
  const writeBack = opts.writeBack ?? true;
  const update = opts.update ?? "merge";
  const attachments = opts.attachments ?? "link";
  const exclude = [".obsidian", ".cephalopod", ...(opts.exclude ?? [])];
  const report: ImportReport = {
    notesCreated: 0, notesUpdated: 0, notesSkipped: 0, wikilinkEdges: 0,
    embedEdges: 0, stubs: 0, attachments: 0, warnings: [],
    durationMs: 0,
  };

  await hub.ensureSpaceExists(space);
  const manifestPath = join(vaultPath, ".cephalopod", "import-manifest.json");
  const manifest: Manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};

  // ---- PASS 1: discover, assign ids, build title/alias -> id maps ----
  interface Entry { full: string; rel: string; title: string; id: string; content: string; contentHash: string; data: Record<string, unknown>; body: string; minted: boolean; }
  const entries: Entry[] = [];
  const titleToId = new Map<string, string>();
  const aliasToId = new Map<string, string>();

  for (const full of walk(vaultPath, exclude)) {
    const rel = relative(vaultPath, full).split(sep).join("/");
    const content = readFileSync(full, "utf8");
    const { data, body } = parseFrontmatter(content);
    const title = basename(full, ".md");
    const fmId = typeof data.cephalopod_id === "string" ? data.cephalopod_id : undefined;
    const id = fmId ?? manifest[rel]?.id ?? pathId(rel);
    const minted = !fmId && !manifest[rel];
    entries.push({ full, rel, title, id, content, contentHash: hash(content), data, body, minted });
    titleToId.set(title.toLowerCase(), id);
    for (const a of asTags(data.aliases)) aliasToId.set(a.toLowerCase(), id);
  }

  const resolve = (text: string): string | undefined =>
    titleToId.get(text.toLowerCase()) ?? aliasToId.get(text.toLowerCase());

  // index attachment files (by relpath + basename) when uploading to the blob store
  const attIndex = new Map<string, string>();
  if (attachments === "upload") {
    for (const full of walkAll(vaultPath, exclude)) {
      if (full.endsWith(".md")) continue;
      const rel = relative(vaultPath, full).split(sep).join("/");
      attIndex.set(rel.toLowerCase(), full);
      attIndex.set(basename(full).toLowerCase(), full);
    }
  }

  // ---- PASS 2: bodies, links, attachments, write ----
  for (const e of entries) {
    if (update === "skip" && manifest[e.rel]?.hash === e.contentHash && (await hub.hasNote(space, e.id))) {
      report.notesSkipped++;
      continue;
    }

    // upload referenced attachments first (async), then rewrite links to blob URLs
    const blobUrl = new Map<string, string>();
    if (attachments === "upload" && !opts.dryRun) {
      for (const m of e.body.matchAll(LINK)) {
        const [, bang, , target] = m;
        const tgt = String(target).trim();
        if (bang !== "!" || !IMG.test(tgt) || blobUrl.has(tgt)) continue;
        const file = attIndex.get(tgt.toLowerCase()) ?? attIndex.get(basename(tgt).toLowerCase());
        if (!file) { report.warnings.push(`attachment not found for upload: ${tgt} in ${e.rel}`); continue; }
        const meta = await hub.putBlob(space, new Uint8Array(readFileSync(file)), mimeOf(file));
        blobUrl.set(tgt, `/v1/spaces/${encodeURIComponent(space)}/blobs/${meta.hash}`);
      }
    }

    const embedTargets: string[] = [];
    const rewritten = e.body.replace(LINK, (match, bang, type, target, anchor, alias) => {
      const display = (alias ?? target).trim();
      const tgt = String(target).trim();
      if (bang === "!") {
        if (IMG.test(tgt)) {
          report.attachments++;
          if (attachments === "skip") {
            report.warnings.push(`skipped attachment ${tgt} in ${e.rel}`);
            return "";
          }
          const url = blobUrl.get(tgt);
          if (url) return `![${display}](${url})`; // uploaded to the blob store
          return `![${display}](${encodeURI(tgt)})`; // link mode (or upload miss)
        }
        const id = resolve(tgt);
        if (id) { embedTargets.push(id); return `![[${id}|${display}]]`; }
        report.stubs++;
        return match; // unresolved embed -> leave title so the brain mints a stub
      }
      report.wikilinkEdges++;
      const id = resolve(tgt);
      if (!id || opts.keepTitles) {
        if (!id) report.stubs++;
        return match; // leave [[Title]] (brain resolves by title / mints stub)
      }
      const a = anchor ?? "";
      const ty = type ? `${type}:: ` : "";
      return `[[${ty}${id}${a}|${display}]]`; // id-form for rename stability (08 §5)
    });

    // props/tags from frontmatter
    const { cephalopod_id, tags, aliases, ...rest } = e.data;
    const props: Record<string, unknown> = { ...rest, path: e.rel.split("/").slice(0, -1).join("/"), authoredBy: "human" };
    if (aliases) props.aliases = asTags(aliases);
    const fields = { title: e.title, body: rewritten, tags: asTags(tags), props };

    if (!opts.dryRun) {
      if (await hub.hasNote(space, e.id)) {
        await hub.patchNote(space, e.id, fields); // merge or overwrite (skip handled above)
        report.notesUpdated++;
      } else {
        await hub.createNote(space, fields, e.id);
        report.notesCreated++;
      }
      for (const t of new Set(embedTargets)) {
        await hub.linkNote(space, e.id, t, "embeds");
        report.embedEdges++;
      }
      manifest[e.rel] = { id: e.id, hash: e.contentHash };
      if (writeBack && e.minted) writeFileSync(e.full, withCephalopodId(e.content, e.id));
    } else {
      for (const _ of new Set(embedTargets)) report.embedEdges++;
    }
  }

  if (!opts.dryRun) {
    mkdirSync(join(vaultPath, ".cephalopod"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  report.durationMs = Math.round(performance.now() - t0);
  return report;
}
