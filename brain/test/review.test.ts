// #30 history/blame + #29 review queue, over a real brain (hub + HTTP).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { Auth } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";

describe("note history / blame (#30)", () => {
  it("reconstructs attributed edits with field-level changes", async () => {
    const hub = new SpaceHub(new SqliteStore(":memory:"));
    await hub.createNote("kb", { title: "Design", body: "v1" }, "n_1", "alice");
    await hub.patchNote("kb", "n_1", { body: "v1 plus more" }, "bob");
    await hub.patchNote("kb", "n_1", { tags: ["draft"] }, "agent-7");

    const hist = await hub.noteHistory("kb", "n_1");
    expect(hist.compacted).toBe(false);
    expect(hist.entries).toHaveLength(3);

    const [create, edit, tagged] = hist.entries;
    expect(create.actor).toBe("alice");
    expect(create.changes.fields).toContain("title");
    expect(create.changes.title).toBe("Design");

    expect(edit.actor).toBe("bob");
    expect(edit.changes.fields).toContain("body");
    expect(edit.changes.bodyDelta).toBe("v1 plus more".length - "v1".length);

    expect(tagged.actor).toBe("agent-7");
    expect(tagged.changes.tagsAdded).toContain("draft");
    expect(tagged.changes.fields).toContain("tags");
  });

  it("flags history folded into a snapshot as compacted", async () => {
    const hub = new SpaceHub(new SqliteStore(":memory:"), { snapshotEvery: 1 }); // snapshot after every update
    await hub.createNote("kb", { title: "S", body: "a" }, "n_s", "alice");
    await hub.patchNote("kb", "n_s", { body: "ab" }, "alice"); // prior edits now under a snapshot
    const hist = await hub.noteHistory("kb", "n_s");
    expect(hist.compacted).toBe(true);
  });
});

describe("review queue (#29)", () => {
  let server: Server, port: number, store: SqliteStore, adminToken: string, hub: SpaceHub;
  const api = (m: string, p: string, t = adminToken, body?: unknown) =>
    fetch(`http://localhost:${port}/v1${p}`, {
      method: m,
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  beforeAll(async () => {
    store = new SqliteStore(":memory:");
    const auth = new Auth(store);
    hub = new SpaceHub(store);
    const admin = (await auth.bootstrapAdmin())!;
    adminToken = admin.token;
    await auth.setRole("kb", admin.principal.id, "admin"); // notes are seeded via the hub, so grant membership explicitly
    await hub.createNote("kb", { title: "Live note", body: "published" }, "n_live");
    await hub.createNote("kb", { title: "Agent draft", body: "drafted by an agent", tags: ["draft"], props: { authoredBy: "agent" } }, "n_draft", "agent-1");
    await hub.createNote("kb", { title: "Quarantined", body: "no facets", tags: ["needs-facets"] }, "n_q");
    server = createHttpServer(hub, auth);
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as any).port;
  });
  afterAll(() => { server.close(); store.close(); });

  it("lists only gated notes, with gates + provenance, newest first", async () => {
    const r = await api("GET", "/spaces/kb/review");
    expect(r.status).toBe(200);
    const ids = r.body.items.map((i: any) => i.id);
    expect(ids).toContain("n_draft");
    expect(ids).toContain("n_q");
    expect(ids).not.toContain("n_live"); // not gated
    const draft = r.body.items.find((i: any) => i.id === "n_draft");
    expect(draft.gates).toContain("draft");
    expect(draft.authoredBy).toBe("agent");
    expect(draft.lastEditedBy).toBe("agent-1");
    expect(draft.preview).toContain("drafted by an agent");
  });

  it("promote clears the draft gate and removes it from the queue", async () => {
    expect((await api("POST", "/spaces/kb/notes/n_draft/promote")).status).toBe(200);
    const r = await api("GET", "/spaces/kb/review");
    expect(r.body.items.map((i: any) => i.id)).not.toContain("n_draft");
  });

  it("history endpoint resolves actor kind and 404s for missing notes", async () => {
    const h = await api("GET", "/spaces/kb/notes/n_q/history");
    expect(h.status).toBe(200);
    expect(h.body.entries[0].actor).toBe("system"); // created via hub default actor
    expect((await api("GET", "/spaces/kb/notes/n_missing/history")).status).toBe(404);
  });
});
