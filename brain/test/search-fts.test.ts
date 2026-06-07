// Regression: user search input must never reach FTS5 as a raw MATCH expression.
// FTS5 has its own grammar (", *, :, AND, OR, NEAR, parens, …); unescaped input
// used to throw `fts5: syntax error` and surface as a 500 leaking SQLite internals.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { Auth } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";

let server: Server;
let port: number;
let store: SqliteStore;
let token: string;

beforeAll(async () => {
  store = new SqliteStore(":memory:");
  const auth = new Auth(store);
  const hub = new SpaceHub(store);
  token = (await auth.bootstrapAdmin())!.token;
  server = createHttpServer(hub, auth);
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as any).port;
  await api("POST", "/spaces", { name: "kb" });
  await api("POST", "/spaces/kb/notes", { title: "Gateway", body: "deploy the gateway service to prod" });
  await api("POST", "/spaces/kb/notes", { title: "Cpp", body: "written in C++ and a bit of C#" });
});
afterAll(() => {
  server.close();
  store.close();
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const search = (q: string) => api("GET", `/spaces/kb/search?q=${encodeURIComponent(q)}`);

describe("FTS search input is sanitized", () => {
  it("plain terms still match", async () => {
    const r = await search("gateway");
    expect(r.status).toBe(200);
    expect(r.body.hits.map((h: any) => h.title)).toContain("Gateway");
  });

  it("multi-word query is an implicit AND of terms", async () => {
    expect((await search("gateway service")).body.hits.map((h: any) => h.title)).toContain("Gateway");
    expect((await search("gateway nonexistentword")).body.hits).toHaveLength(0);
  });

  // each of these would previously throw fts5: syntax error -> HTTP 500
  for (const q of ['gateway"', "AND", "OR", "NEAR", "*", '"unterminated', "foo:bar", "(", "a^b", "-gateway"]) {
    it(`does not 500 on operator-laden query ${JSON.stringify(q)}`, async () => {
      expect((await search(q)).status).toBe(200);
    });
  }

  it("matches tokens that contain FTS operator characters literally", async () => {
    const r = await search("C++");
    expect(r.status).toBe(200);
    expect(r.body.hits.map((h: any) => h.title)).toContain("Cpp");
  });

  it("blank query yields no results, not an error", async () => {
    const r = await search("   ");
    expect(r.status).toBe(200);
    expect(r.body.hits).toHaveLength(0);
  });
});
