// Per-space required facets (client/project) + faceted filtering. Facets are
// key:value tags (01 §1.3); requirement is opt-in per space, with a #shared
// exemption; client/project are first-class nodes by convention (belongs_to).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { Auth } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";

let server: Server;
let port: number;
let store: SqliteStore;
let admin: string;

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  admin = (await auth.bootstrapAdmin())!.token;
  server = createHttpServer(hub, auth);
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as any).port;
  await api("POST", "/spaces", admin, { name: "agency" });
  await api("PUT", "/spaces/agency/settings", admin, { requiredFacets: ["client", "project"] });
});
afterAll(() => {
  server.close();
  store.close();
});

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("required facets + faceted filtering", () => {
  it("exposes the requirement in settings", async () => {
    expect((await api("GET", "/spaces/agency/settings", admin)).body.requiredFacets).toEqual(["client", "project"]);
  });

  it("rejects notes missing required facets, accepts complete ones", async () => {
    const bad = await api("POST", "/spaces/agency/notes", admin, { title: "Orphan", body: "no facets" });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/client, project/);

    const good = await api("POST", "/spaces/agency/notes", admin, {
      title: "Acme Billing Report", body: "quarterly report", tags: ["client:acme", "project:billing"],
    });
    expect(good.status).toBe(201);
  });

  it("exempts #shared notes and facet-type nodes", async () => {
    expect((await api("POST", "/spaces/agency/notes", admin, { title: "Shared Lib", body: "x", tags: ["shared"] })).status).toBe(201);
    // a #client node doesn't need a client: facet
    expect((await api("POST", "/spaces/agency/notes", admin, { title: "Acme", body: "the client", tags: ["client"] })).status).toBe(201);
  });

  it("filters search and listing by facet tag", async () => {
    await api("POST", "/spaces/agency/notes", admin, {
      title: "Globex Report", body: "quarterly report", tags: ["client:globex", "project:infra"],
    });
    const all = await api("GET", "/spaces/agency/search?q=report", admin);
    expect(all.body.hits.length).toBeGreaterThanOrEqual(2);
    const acme = await api("GET", "/spaces/agency/search?q=report&tag=client:acme", admin);
    expect(acme.body.hits.every((h: any) => h.tags.includes("client:acme"))).toBe(true);
    expect(acme.body.hits.length).toBe(1);

    const infra = await api("GET", "/spaces/agency/notes?tag=project:infra", admin);
    expect(infra.body.notes.every((n: any) => n.tags.includes("project:infra"))).toBe(true);
    expect(infra.body.notes.some((n: any) => n.title === "Globex Report")).toBe(true);
  });

  it("enforces facets on explicit tag changes (PATCH)", async () => {
    const id = (await api("POST", "/spaces/agency/notes", admin, {
      title: "Patch Me", body: "z", tags: ["client:acme", "project:billing"],
    })).body.id;
    expect((await api("PATCH", `/spaces/agency/notes/${id}`, admin, { tags: ["client:acme"] })).status).toBe(422);
    expect((await api("PATCH", `/spaces/agency/notes/${id}`, admin, { tags: ["client:acme", "project:x"] })).status).toBe(200);
  });

  it("does not affect spaces without a requirement", async () => {
    await api("POST", "/spaces", admin, { name: "freeform" });
    expect((await api("POST", "/spaces/freeform/notes", admin, { title: "Anything", body: "no facets needed" })).status).toBe(201);
  });

  it("client & project as first-class nodes via belongs_to", async () => {
    const client = (await api("POST", "/spaces/agency/notes", admin, { title: "Initech", body: "client", tags: ["client"] })).body.id;
    const project = (await api("POST", "/spaces/agency/notes", admin, {
      title: "Initech Portal", body: "engagement", tags: ["project", "client:initech"],
    })).body.id;
    await api("POST", "/spaces/agency/links", admin, { from: project, to: client, type: "belongs_to" });
    const nb = await api("GET", `/spaces/agency/notes/${project}/neighbors?hops=1`, admin);
    expect(nb.body.edges.some((e: any) => e.to === client && e.type === "belongs_to")).toBe(true);
  });
});
