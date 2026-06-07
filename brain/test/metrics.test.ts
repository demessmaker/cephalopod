// Track E (ops): Prometheus /metrics endpoint + the Metrics counter.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { SqliteStore } from "../src/store/sqlite.js";
import { SpaceHub } from "../src/hub.js";
import { Auth } from "../src/auth.js";
import { createHttpServer } from "../src/http.js";
import { Metrics } from "../src/metrics.js";

describe("Metrics", () => {
  it("renders Prometheus text with request counters by status class", () => {
    const m = new Metrics();
    m.record(200); m.record(201); m.record(404); m.record(500);
    const text = m.render();
    expect(text).toContain("cephalopod_http_requests_total 4");
    expect(text).toContain(`cephalopod_http_responses_total{class="2xx"} 2`);
    expect(text).toContain(`cephalopod_http_responses_total{class="4xx"} 1`);
    expect(text).toContain(`cephalopod_http_responses_total{class="5xx"} 1`);
    expect(text).toMatch(/cephalopod_uptime_seconds \d+/);
    expect(text).toMatch(/cephalopod_resident_memory_bytes \d+/);
  });
});

describe("/metrics endpoint", () => {
  let server: Server, port: number, admin: string, store: SqliteStore;
  beforeAll(async () => {
    store = new SqliteStore(":memory:");
    const auth = new Auth(store);
    admin = (await auth.bootstrapAdmin())!.token;
    server = createHttpServer(new SpaceHub(store), auth, { metrics: new Metrics() });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as any).port;
  });
  afterAll(() => { server.close(); store.close(); });

  it("counts handled responses and serves them unauthenticated", async () => {
    await fetch(`http://localhost:${port}/v1/spaces`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ name: "kb" }) });
    await fetch(`http://localhost:${port}/v1/spaces/nope/notes/x`, { headers: { authorization: `Bearer ${admin}` } }); // a 4xx

    const res = await fetch(`http://localhost:${port}/metrics`); // no auth needed
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toMatch(/cephalopod_http_requests_total [1-9]/);
    expect(text).toContain("cephalopod_http_responses_total");
  });
});
