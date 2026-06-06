// Minimal YAML-frontmatter parser for Obsidian notes (08 §2). Handles the subset
// Obsidian actually uses: `key: value`, inline `[a, b]` lists, and block lists
// (`key:` then `  - item`). Not a full YAML implementation.

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  raw: string; // the frontmatter block incl. fences, or "" if none
}

const unquote = (s: string) => s.replace(/^["']|["']$/g, "").trim();

function parseScalarOrInlineList(v: string): unknown {
  const t = v.trim();
  if (t === "") return "";
  if (t.startsWith("[") && t.endsWith("]")) {
    return t
      .slice(1, -1)
      .split(",")
      .map((x) => unquote(x))
      .filter((x) => x.length > 0);
  }
  return unquote(t);
}

export function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith("---")) return { data: {}, body: content, raw: "" };
  // the closing fence must be a full line of exactly `---` (optional trailing
  // spaces), so a body horizontal-rule or a `---more` line isn't mistaken for it.
  const close = content.slice(3).match(/\n---[ \t]*(\r?\n|$)/);
  if (!close || close.index === undefined) return { data: {}, body: content, raw: "" };
  const fenceAt = 3 + close.index; // the "\n" just before the closing ---
  const afterFence = fenceAt + close[0].length; // close fence consumed its own newline
  const raw = content.slice(0, afterFence);
  const block = content.slice(content.indexOf("\n") + 1, fenceAt);
  const body = content.slice(afterFence);

  const data: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    if (rest === "") {
      // possible block list on following indented lines
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s+-\s+/, "")));
      }
      data[key] = items.length ? items : "";
    } else {
      data[key] = parseScalarOrInlineList(rest);
    }
  }
  return { data, body, raw };
}

// Inject/replace a `cephalopod_id` key in a file's frontmatter (write-back, 08 §3).
export function withCephalopodId(content: string, id: string): string {
  const fm = parseFrontmatter(content);
  if (!fm.raw) return `---\ncephalopod_id: ${id}\n---\n${content}`;
  if ("cephalopod_id" in fm.data) {
    return content.replace(/cephalopod_id:.*(\r?\n)/, `cephalopod_id: ${id}$1`);
  }
  // insert after the opening fence
  return content.replace(/^---\r?\n/, `---\ncephalopod_id: ${id}\n`);
}
