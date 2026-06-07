// Dev server for the graph explorer: serves the static app and reverse-proxies
// /v1/* to the brain (so the browser talks same-origin, no CORS). The live-update
// WebSocket connects directly to the brain (browsers allow cross-origin ws).
import { createServer as createHttp, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// Hop-by-hop headers (RFC 7230 §6.1) must not be forwarded by a proxy. Passing
// client-controlled ones through is a request-smuggling/desync footgun.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const stripHopByHop = (headers) =>
  Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase())));

/** Create the explorer web server. brainUrl is the brain's HTTP base (e.g. http://localhost:7701). */
export function createWebServer({ brainUrl = "http://localhost:7701", staticDir = DIR } = {}) {
  const brain = new URL(brainUrl);
  return createHttp(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // reverse-proxy the API
    if (url.pathname.startsWith("/v1/")) {
      const fwdHeaders = { ...stripHopByHop(req.headers), host: brain.host };
      const proxied = httpRequest(
        { hostname: brain.hostname, port: brain.port, path: url.pathname + url.search, method: req.method, headers: fwdHeaders },
        (pr) => {
          res.writeHead(pr.statusCode ?? 502, stripHopByHop(pr.headers));
          pr.pipe(res);
        },
      );
      proxied.on("error", () => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "brain unreachable" }));
      });
      req.pipe(proxied);
      return;
    }

    // liveness probe (containers / orchestration)
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
    }

    // static files
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = join(staticDir, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    if (!full.startsWith(staticDir)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    try {
      const body = await readFile(full);
      res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
}

// CLI: node src/serve.mjs   (env: PORT, BRAIN_URL)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8080);
  const brainUrl = process.env.BRAIN_URL ?? "http://localhost:7701";
  createWebServer({ brainUrl }).listen(port, () =>
    console.log(`🐙 cephalopod explorer on http://localhost:${port}  (proxying /v1 -> ${brainUrl})`),
  );
}
