// M2.5 acceptance: Obsidian vault import — mapping, links/stubs, embeds,
// frontmatter, idempotency/re-import, and write-back.
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { importVault } from "../src/import/obsidian.js";
import { stubId } from "../src/core/ids.js";

const dirs: string[] = [];
function makeVault(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch {}
});

function fresh() {
  const store = new SqliteStore(":memory:");
  return { store, hub: new SpaceHub(store) };
}

describe("M2.5 — Obsidian importer", () => {
  it("imports files as notes with frontmatter tags/props and folder path", () => {
    const vault = makeVault({
      "services/Billing.md": `---\ntags: [service, tier-1]\naliases:\n  - Billing Service\nstatus: active\n---\nCharges customers. Depends on [[Gateway]].`,
      "services/Gateway.md": `# Gateway\nProcesses payments.`,
    });
    const { hub } = fresh();
    const r = importVault(hub, "sp", vault, { writeBack: false });

    expect(r.notesCreated).toBe(2);
    const billing = hub.getNoteSnapshot("sp", hub.search("sp", "Charges")[0].id);
    expect(billing.title).toBe("Billing");
    expect(billing.tags).toContain("service");
    expect(billing.props.status).toBe("active");
    expect(billing.props.path).toBe("services");
    expect(billing.props.aliases).toContain("Billing Service");
  });

  it("parses frontmatter without tripping on body horizontal rules", () => {
    const vault = makeVault({
      // a `---` horizontal rule in the body must not be read as the closing fence
      "Note.md": `---\ntags: [doc]\nstatus: active\n---\nIntro paragraph.\n\n---\n\nSection after a rule.`,
    });
    const { hub } = fresh();
    const r = importVault(hub, "sp", vault, { writeBack: false });
    expect(r.notesCreated).toBe(1);
    const snap = hub.getNoteSnapshot("sp", hub.search("sp", "Intro")[0].id);
    expect(snap.tags).toContain("doc");
    expect(snap.props.status).toBe("active");
    expect(snap.body).toContain("Section after a rule."); // hr + following text kept in body
    expect(snap.body).not.toContain("status: active"); // frontmatter not leaked into body
  });

  it("does not follow symlinks out of the vault", () => {
    // a file the importer should never reach, living outside the vault
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.md"), "TOPSECRET exfiltrated content");

    const vault = makeVault({ "Real.md": "i am a legitimate note" });
    symlinkSync(join(outside, "secret.md"), join(vault, "Leak.md")); // symlinked file
    symlinkSync(outside, join(vault, "outdir")); // symlinked directory

    const { hub } = fresh();
    const r = importVault(hub, "sp", vault, { writeBack: false });

    expect(r.notesCreated).toBe(1); // only Real.md, not the symlinked targets
    expect(hub.search("sp", "TOPSECRET")).toHaveLength(0); // outside content never imported
  });

  it("resolves [[wikilinks]] to edges and mints stubs for unresolved", () => {
    const vault = makeVault({
      "A.md": `links to [[B]] and to [[Ghost]]`,
      "B.md": `i am B`,
    });
    const { hub } = fresh();
    importVault(hub, "sp", vault, { writeBack: false });
    const aId = hub.search("sp", "links")[0].id;
    const nb = hub.neighbors("sp", aId, 1);
    const targets = nb.nodes.map((n) => n.title).sort();
    expect(targets).toContain("B");
    expect(targets).toContain("Ghost"); // stub
    expect(nb.nodes.find((n) => n.title === "Ghost")?.stub).toBe(true);
    expect(nb.edges.length).toBeGreaterThanOrEqual(2);
  });

  it("turns note embeds into `embeds` edges and attachments into links", () => {
    const vault = makeVault({
      "Index.md": `![[Section]] and image ![[diagram.png]]`,
      "Section.md": `the section`,
    });
    const { hub } = fresh();
    const r = importVault(hub, "sp", vault, { writeBack: false });
    expect(r.embedEdges).toBe(1);
    expect(r.attachments).toBe(1);
    const idxId = hub.search("sp", "image")[0].id;
    const snap = hub.getNoteSnapshot("sp", idxId);
    expect(snap.outLinks.some((l) => l.type === "embeds")).toBe(true);
    expect(snap.body).toContain("![diagram.png](diagram.png)"); // attachment rewritten
    expect(snap.body).not.toContain("![[diagram.png]]");
  });

  it("rewrites resolved links to id-form for rename stability", () => {
    const vault = makeVault({ "A.md": `see [[B]]`, "B.md": `b` });
    const { hub } = fresh();
    importVault(hub, "sp", vault, { writeBack: false });
    const a = hub.getNoteSnapshot("sp", hub.search("sp", "see")[0].id);
    expect(a.body).toMatch(/\[\[n_[a-f0-9]+\|B\]\]/);
  });

  it("is idempotent: re-import updates, does not duplicate", () => {
    const vault = makeVault({ "A.md": `hello [[B]]`, "B.md": `b` });
    const { hub } = fresh();
    const first = importVault(hub, "sp", vault, { writeBack: false });
    expect(first.notesCreated).toBe(2);
    const second = importVault(hub, "sp", vault, { writeBack: false });
    expect(second.notesCreated).toBe(0);
    expect(second.notesUpdated).toBe(2);
    // same ids (path-deterministic) => no duplicate nodes
    const all = hub.search("sp", "hello");
    expect(all.length).toBe(1);
  });

  it("write-back injects cephalopod_id into the source file", () => {
    const vault = makeVault({ "Note.md": `body` });
    const { hub } = fresh();
    importVault(hub, "sp", vault, { writeBack: true });
    const written = readFileSync(join(vault, "Note.md"), "utf8");
    expect(written).toMatch(/^---\ncephalopod_id: n_[a-f0-9]+\n---/);
  });
});
