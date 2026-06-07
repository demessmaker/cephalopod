// Track D: bidirectional Obsidian sync — note->markdown serialization, vault export,
// and the round-trip reconcile (vault-only edit, brain-only edit, both-sides
// conflict, and creates in each direction), all idempotent across repeated syncs.
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { importVault } from "../src/import/obsidian.js";
import { exportVault } from "../src/import/export.js";
import { syncVault } from "../src/import/sync.js";
import { serializeNote } from "../src/import/markdown.js";

const dirs: string[] = [];
function makeVault(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
afterEach(() => {
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch {}
});
const fresh = () => new SpaceHub(new SqliteStore(":memory:"));

describe("note -> markdown serialization", () => {
  it("emits frontmatter (id/tags/aliases/custom) and rewrites id-links to titles", async () => {
    const hub = fresh();
    await hub.createNote("sp", { title: "Gateway", body: "gw" }, "n_gateway");
    const id = await hub.createNote("sp", {
      title: "Billing",
      body: "Charges via [[n_gateway|the gateway]] and [[n_gateway]].",
      tags: ["service"],
      props: { status: "active", aliases: ["Billing Service"], path: "services", authoredBy: "human" },
    });
    const snap = await hub.getNoteSnapshot("sp", id);
    const md = serializeNote(snap, new Map([["n_gateway", "Gateway"]]));

    expect(md).toContain(`cephalopod_id: ${id}`);
    expect(md).toContain("tags: [service]");
    expect(md).toContain("aliases: [Billing Service]");
    expect(md).toContain("status: active");
    expect(md).not.toContain("path:"); // internal — encoded in the file location
    expect(md).not.toContain("authoredBy:"); // internal provenance
    expect(md).toContain("[[Gateway|the gateway]]"); // id -> title, alias kept
    expect(md).toContain("and [[Gateway]]."); // redundant alias dropped
  });
});

describe("vault export (brain -> Obsidian)", () => {
  it("writes a file per note at <path>/<title>.md and is incremental", async () => {
    const hub = fresh();
    await hub.createNote("sp", { title: "Billing", body: "charges", props: { path: "services" } });
    await hub.createNote("sp", { title: "Readme", body: "top level" });
    const vault = makeVault();

    const r1 = await exportVault(hub, "sp", vault);
    expect(r1.filesWritten).toBe(2);
    expect(existsSync(join(vault, "services/Billing.md"))).toBe(true);
    expect(read(vault, "Readme.md")).toContain("top level");

    // nothing changed -> a second export writes nothing
    const r2 = await exportVault(hub, "sp", vault);
    expect(r2.filesWritten).toBe(0);
    expect(r2.filesUnchanged).toBe(2);
  });
});

describe("bidirectional sync", () => {
  it("import -> export -> sync is a stable round trip (no phantom changes)", async () => {
    const vault = makeVault({
      "Billing.md": `---\ntags: [service]\n---\nCharges customers. See [[Gateway]].`,
      "Gateway.md": `Processes payments.`,
    });
    const hub = fresh();
    await importVault(hub, "sp", vault, { writeBack: true });
    await exportVault(hub, "sp", vault);

    // a fresh sync with neither side touched must be a no-op
    const r = await syncVault(hub, "sp", vault);
    expect(r.imported).toBe(0);
    expect(r.exported).toBe(0);
    expect(r.conflicts).toHaveLength(0);
    expect(r.unchanged).toBeGreaterThan(0);
  });

  it("propagates a vault-only edit into the brain", async () => {
    const vault = makeVault({ "Note.md": `---\ntags: [a]\n---\noriginal body` });
    const hub = fresh();
    await syncVault(hub, "sp", vault); // initial: imports Note, writes back id

    const id = (await hub.search("sp", "original"))[0].id;
    writeFileSync(join(vault, "Note.md"), read(vault, "Note.md").replace("original body", "edited in vault"));

    const r = await syncVault(hub, "sp", vault);
    expect(r.imported).toBe(1);
    expect(r.exported).toBe(0);
    expect((await hub.getNoteSnapshot("sp", id)).body).toContain("edited in vault");
  });

  it("propagates a brain-only edit out to the vault", async () => {
    const vault = makeVault({ "Note.md": `body v1` });
    const hub = fresh();
    await syncVault(hub, "sp", vault);
    const id = (await hub.search("sp", "body"))[0].id;

    await hub.patchNote("sp", id, { body: "body v2 from brain" });
    const r = await syncVault(hub, "sp", vault);
    expect(r.exported).toBe(1);
    expect(r.imported).toBe(0);
    expect(read(vault, "Note.md")).toContain("body v2 from brain");
  });

  it("flags a both-sides conflict: brain wins, vault copy preserved + note tagged", async () => {
    const vault = makeVault({ "Note.md": `shared body` });
    const hub = fresh();
    await syncVault(hub, "sp", vault);
    const id = (await hub.search("sp", "shared"))[0].id;

    // diverge on BOTH sides since last sync
    await hub.patchNote("sp", id, { body: "brain edit" });
    writeFileSync(join(vault, "Note.md"), read(vault, "Note.md").replace("shared body", "vault edit"));

    const r = await syncVault(hub, "sp", vault, { conflict: "brain" });
    expect(r.conflicts).toContain(id);
    expect((await hub.getNoteSnapshot("sp", id)).tags).toContain("sync-conflict");
    expect(read(vault, "Note.md")).toContain("brain edit"); // brain won the file
    expect(read(vault, "Note.conflict.md")).toContain("vault edit"); // vault copy preserved
  });

  it("creates in both directions: new vault file -> brain, new brain note -> vault", async () => {
    const vault = makeVault({ "FromVault.md": `made in the vault` });
    const hub = fresh();
    await hub.createNote("sp", { title: "FromBrain", body: "made in the brain" });

    const r = await syncVault(hub, "sp", vault);
    expect(r.imported).toBe(1); // FromVault -> brain
    expect(r.exported).toBe(1); // FromBrain -> vault
    expect((await hub.search("sp", "made in the vault")).length).toBe(1);
    expect(existsSync(join(vault, "FromBrain.md"))).toBe(true);
    // the new vault file got its cephalopod_id written back
    expect(read(vault, "FromVault.md")).toContain("cephalopod_id:");

    // and a follow-up sync settles to a no-op
    const r2 = await syncVault(hub, "sp", vault);
    expect(r2.imported + r2.exported + r2.conflicts.length).toBe(0);
  });
});
