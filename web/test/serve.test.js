// The dev server serves the static app and reverse-proxies /v1 to the brain.
// Uses a stub upstream so the web layer is tested in isolation.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { createWebServer } from "../src/serve.mjs";

// raw client so we can set hop-by-hop headers that fetch() forbids
function rawGet(port, path, headers) {
  return new Promise((resolve) => {
    const r = httpRequest({ port, path, method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    r.end();
  });
}

let upstream, web, upPort, webPort;
const seen = [];

beforeAll(async () => {
  // stub "brain": records requests, echoes canned API responses
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, headers: req.headers, body });
      res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: req.url, method: req.method }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  upPort = upstream.address().port;

  web = createWebServer({ brainUrl: `http://localhost:${upPort}` });
  await new Promise((r) => web.listen(0, r));
  webPort = web.address().port;
});
afterAll(() => {
  web.close();
  upstream.close();
});

const W = (p) => `http://localhost:${webPort}${p}`;

describe("web explorer dev server", () => {
  it("serves the static app", async () => {
    const html = await fetch(W("/"));
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("Cephalopod");

    const js = await fetch(W("/graph.js"));
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("buildGraph");
  });

  it("404s unknown static paths and blocks traversal", async () => {
    expect((await fetch(W("/nope.js"))).status).toBe(404);
    expect((await fetch(W("/../package.json"))).status).toBe(404);
  });

  it("reverse-proxies /v1 to the brain, preserving method, path, auth, body", async () => {
    const res = await fetch(W("/v1/spaces/eng/notes"), {
      method: "POST",
      headers: { authorization: "Bearer cph_test", "content-type": "application/json" },
      body: JSON.stringify({ title: "Proxied" }),
    });
    expect(res.status).toBe(201);
    const got = seen.find((s) => s.url === "/v1/spaces/eng/notes" && s.method === "POST");
    expect(got).toBeDefined();
    expect(got.auth).toBe("Bearer cph_test");
    expect(JSON.parse(got.body).title).toBe("Proxied");

    // query strings pass through too
    await fetch(W("/v1/spaces/eng/search?q=web&mode=hybrid"), { headers: { authorization: "Bearer x" } });
    expect(seen.some((s) => s.url === "/v1/spaces/eng/search?q=web&mode=hybrid")).toBe(true);
  });

  it("strips hop-by-hop headers when proxying", async () => {
    await rawGet(webPort, "/v1/spaces/hop", {
      authorization: "Bearer x",
      te: "trailers", // hop-by-hop -> must not reach upstream
      "x-app": "keep-me", // ordinary header -> forwarded
    });
    const got = seen.find((s) => s.url === "/v1/spaces/hop");
    expect(got).toBeDefined();
    expect(got.headers["x-app"]).toBe("keep-me");
    expect(got.headers.te).toBeUndefined();
    expect(got.headers.host).toBe(`localhost:${upPort}`); // host rewritten to the brain
  });

  it("returns 502 when the brain is unreachable", async () => {
    const lonely = createWebServer({ brainUrl: "http://localhost:1" });
    await new Promise((r) => lonely.listen(0, r));
    const p = lonely.address().port;
    const res = await fetch(`http://localhost:${p}/v1/spaces`, { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(502);
    lonely.close();
  });
});
