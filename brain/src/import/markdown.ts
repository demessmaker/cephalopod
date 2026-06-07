// Note -> Markdown serialization (the inverse of the importer), shared by the
// vault exporter and the bidirectional sync. Renders YAML frontmatter (the subset
// `parseFrontmatter` understands) + a body whose id-form wikilinks are rewritten
// back to human-friendly `[[Title]]` form for the vault.
import { resolve, sep } from "node:path";
import type { NoteSnapshot } from "../hub.js";

// !?[[ type:: target #anchor | alias ]] — same shape the importer parses.
export const LINK = /(!?)\[\[\s*(?:([\w-]+)::\s*)?([^\]|#]+?)\s*(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

// Keys that live in the filesystem layout / are cephalopod-internal provenance and
// must NOT be echoed into vault frontmatter (they're re-derived on import).
const INTERNAL_PROPS = new Set(["path", "authoredBy", "aliases"]);

// Normalize a frontmatter tags/aliases value to a string[] (parity with the importer).
export function asTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).replace(/^#/, ""));
  if (typeof v === "string") return v.split(/[\s,]+/).map((x) => x.replace(/^#/, "")).filter(Boolean);
  return [];
}

// A filesystem-safe file name for a note title (Obsidian forbids these chars; we
// also strip path separators, null bytes, and a leading-dots-only name so a title
// can never introduce a path segment or escape its folder).
export function safeFileName(title: string): string {
  const cleaned = (title || "untitled")
    .replace(/\0/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const safe = /^\.+$/.test(cleaned) ? "" : cleaned; // "." / ".." -> untitled
  return (safe || "untitled") + ".md";
}

// Sanitize a note's `props.path` into a contained relative directory: split on any
// separator, drop empty / "." / ".." / null-bearing segments (so it can't escape
// the vault or be absolute), and strip forbidden chars per segment.
export function safeDir(dir: unknown): string {
  if (typeof dir !== "string") return "";
  return dir
    .split(/[\\/]+/)
    .map((seg) => seg.replace(/\0/g, "").trim())
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .map((seg) => seg.replace(/[:*?"<>|]/g, "-"))
    .join("/");
}

// The vault-relative path a note serializes to: <sanitized props.path>/<title>.md.
export function notePath(snap: NoteSnapshot): string {
  const dir = safeDir(snap.props.path);
  const file = safeFileName(snap.title);
  return dir ? `${dir}/${file}` : file;
}

// Containment guard (defense-in-depth, incl. tampered manifest `rel`s): true iff
// `full` resolves to a path at/under `vaultPath`. Gate every write/delete with this.
export function insideVault(vaultPath: string, full: string): boolean {
  const root = resolve(vaultPath);
  const target = resolve(full);
  return target === root || target.startsWith(root + sep);
}

// Emit a frontmatter block parseable by `parseFrontmatter` (scalars + inline lists).
function emitFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}: [${v.map((x) => String(x)).join(", ")}]`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  return lines.length ? `---\n${lines.join("\n")}\n---\n\n` : "";
}

// Rewrite id-form links (`[[n_abc|Display]]`, `![[n_abc|Display]]`) back to title
// form using an id->title map. Title-form or unknown-id links are left untouched.
export function linksToTitles(body: string, idToTitle: Map<string, string>): string {
  return body.replace(LINK, (match, bang: string, type: string, target: string, anchor: string, alias: string) => {
    const tgt = String(target).trim();
    const title = tgt.startsWith("n_") ? idToTitle.get(tgt) : undefined;
    if (!title) return match; // already title-form, or a stub id we can't name
    const ty = type ? `${type}:: ` : "";
    const a = anchor ?? "";
    const al = (alias ?? "").trim();
    const display = al && al !== title ? `|${al}` : ""; // drop a redundant alias
    return `${bang}[[${ty}${title}${a}${display}]]`;
  });
}

export interface SerializeOptions {
  keepIds?: boolean; // leave links in id-form instead of rewriting to titles
}

// Serialize a note to a Markdown document (frontmatter + body).
export function serializeNote(snap: NoteSnapshot, idToTitle: Map<string, string>, opts: SerializeOptions = {}): string {
  const fm: Record<string, unknown> = { cephalopod_id: snap.id };
  if (snap.tags.length) fm.tags = snap.tags;
  const aliases = snap.props.aliases;
  if (Array.isArray(aliases) && aliases.length) fm.aliases = aliases;
  for (const [k, v] of Object.entries(snap.props)) if (!INTERNAL_PROPS.has(k)) fm[k] = v;
  const body = opts.keepIds ? snap.body : linksToTitles(snap.body, idToTitle);
  return emitFrontmatter(fm) + body;
}
