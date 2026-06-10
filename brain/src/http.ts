// HTTP Query/Command API (03 §2). Built on node:http with a tiny router; writes
// funnel through the same hub path as WS deltas, so HTTP and live editors
// converge. Every route is ACL-checked (05 §2). Async over the (async) hub/auth.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Auth, can, type Action, type Capabilities } from "./auth.js";
import type { SpaceHub } from "./hub.js";
import type { Principal, Role } from "./store/store.js";
import { RateLimiter } from "./ratelimit.js";
import { scanSecrets } from "./secrets.js";
import type { Metrics } from "./metrics.js";

export interface HttpOptions {
  rateLimit?: { capacity: number; refillPerSec: number }; // per-token request rate
  maxBodyBytes?: number; // reject larger request bodies with 413 (default 1 MiB)
  maxBlobBytes?: number; // larger cap for blob uploads (default 25 MiB)
  metrics?: Metrics; // if set, count responses + serve /metrics
  log?: boolean; // structured per-request JSON logging to stdout
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: any;
  rawBody: Buffer; // raw request bytes (for binary uploads); body is the JSON parse of it
  principal: Principal;
  caps: Capabilities;
}
type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/:([A-Za-z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$");
  return { method, re, keys, handler };
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const err = (res: ServerResponse, code: number, msg: string) => json(res, code, { error: msg });
const intParam = (v: string | null, def: number, min: number, max: number): number => {
  if (v === null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
};

export function createHttpServer(hub: SpaceHub, auth: Auth, opts: HttpOptions = {}) {
  const routes: Route[] = [];
  const route = (m: string, p: string, h: Handler) => routes.push(compile(m, "/v1" + p, h));
  const limiter = opts.rateLimit ? new RateLimiter(opts.rateLimit.capacity, opts.rateLimit.refillPerSec) : undefined;

  // require a space role >= action; also enforces a read-only token capability
  const require = async (c: Ctx, action: Action): Promise<boolean> => {
    const role = await auth.roleOf(c.params.space, c.principal.id);
    if (!can(role, action)) {
      err(c.res, 403, `forbidden: need ${action} on ${c.params.space}`);
      return false;
    }
    if ((action === "write" || action === "admin") && c.caps.mode === "read") {
      err(c.res, 403, "token is read-only");
      return false;
    }
    return true;
  };

  // a write to a note with these tags/path is within the token's capability scope
  const inScope = (c: Ctx, tags: string[] = [], path = ""): boolean => {
    const cp = c.caps;
    if (cp.writeTags?.length && !cp.writeTags.some((t) => tags.includes(t))) {
      err(c.res, 403, `token may only write notes tagged: ${cp.writeTags.join(", ")}`);
      return false;
    }
    if (cp.pathPrefix && !String(path).startsWith(cp.pathPrefix)) {
      err(c.res, 403, `token scoped to path "${cp.pathPrefix}"`);
      return false;
    }
    return true;
  };
  const parseCaps = (v: any): Capabilities => (v && typeof v === "object" ? v : {});

  // Minting must not let a capability-restricted token escalate itself (05 §2.2).
  const canMint = (c: Ctx): boolean => {
    const cp = c.caps;
    if (cp.mode === "read" || cp.writeTags?.length || cp.pathPrefix) {
      err(c.res, 403, "capability-scoped tokens cannot mint principals or tokens");
      return false;
    }
    return true;
  };

  // --- principals, tokens & spaces ---
  route("POST", "/principals", async (c) => {
    if (!canMint(c)) return;
    const kind = c.body?.kind === "agent" ? "agent" : "user";
    const p = await auth.createPrincipal(kind, String(c.body?.name ?? kind));
    const caps = parseCaps(c.body?.capabilities);
    json(c.res, 201, { principal: p, token: await auth.issueToken(p.id, caps), capabilities: caps });
  });

  route("POST", "/tokens", async (c) => {
    if (!canMint(c)) return;
    const principalId = c.body?.principalId;
    if (!principalId || !(await auth.getPrincipalById(principalId))) return err(c.res, 400, "valid principalId required");
    const caps = parseCaps(c.body?.capabilities);
    json(c.res, 201, { token: await auth.issueToken(principalId, caps), capabilities: caps });
  });

  route("GET", "/spaces", async (c) => json(c.res, 200, { spaces: await auth.memberships(c.principal.id) }));

  route("POST", "/spaces", async (c) => {
    const name = String(c.body?.name ?? "").trim();
    if (!name) return err(c.res, 400, "name required");
    await auth.setRole(name, c.principal.id, "admin"); // creator becomes admin
    json(c.res, 201, { space: name, role: "admin" });
  });

  route("POST", "/spaces/:space/members", async (c) => {
    if (!(await require(c, "admin"))) return;
    const { principalId, role } = c.body ?? {};
    if (!principalId || !["viewer", "editor", "admin"].includes(role)) return err(c.res, 400, "principalId + role required");
    await auth.setRole(c.params.space, principalId, role as Role);
    json(c.res, 200, { ok: true });
  });

  // per-space settings: agent write policy (05 §4) + required facets
  const settingsOf = async (space: string) => ({
    agentMode: await hub.getAgentMode(space),
    requiredFacets: await hub.getRequiredFacets(space),
    maxNotes: await hub.getMaxNotes(space),
    secretScan: await hub.getSecretScan(space),
  });
  route("GET", "/spaces/:space/settings", async (c) => {
    if (!(await require(c, "read"))) return;
    json(c.res, 200, await settingsOf(c.params.space));
  });
  route("PUT", "/spaces/:space/settings", async (c) => {
    if (!(await require(c, "admin"))) return;
    const { agentMode, requiredFacets, maxNotes } = c.body ?? {};
    if (agentMode !== undefined) {
      if (agentMode !== "draft" && agentMode !== "open") return err(c.res, 400, "agentMode must be draft|open");
      await hub.setAgentMode(c.params.space, agentMode);
    }
    if (requiredFacets !== undefined) {
      if (!Array.isArray(requiredFacets) || requiredFacets.some((f) => typeof f !== "string"))
        return err(c.res, 400, "requiredFacets must be a string[]");
      await hub.setRequiredFacets(c.params.space, requiredFacets);
    }
    if (maxNotes !== undefined) {
      if (typeof maxNotes !== "number" || maxNotes < 0) return err(c.res, 400, "maxNotes must be a non-negative number");
      await hub.setMaxNotes(c.params.space, maxNotes);
    }
    if (c.body?.secretScan !== undefined) {
      if (!["off", "warn", "block"].includes(c.body.secretScan)) return err(c.res, 400, "secretScan must be off|warn|block");
      await hub.setSecretScan(c.params.space, c.body.secretScan);
    }
    json(c.res, 200, await settingsOf(c.params.space));
  });

  // Draft-gate (05 §4): agent writes are provenance-stamped and, in "draft" mode,
  // forced to #draft; agents may only touch their own drafts.
  const DRAFT = "draft";
  const gated = async (c: Ctx) => c.principal.kind === "agent" && (await hub.getAgentMode(c.params.space)) === "draft";
  const stamp = (kind: string) => (kind === "agent" ? "agent" : "human");

  const facetError = async (c: Ctx, tags: string[]): Promise<boolean> => {
    const miss = await hub.missingFacets(c.params.space, tags);
    if (miss.length) {
      err(c.res, 422, `missing required facets: ${miss.join(", ")} — add tags like client:acme, or tag "shared" to exempt`);
      return true;
    }
    return false;
  };
  const tagFilters = (c: Ctx) => c.url.searchParams.getAll("tag");
  const SECRET = "secret-suspected";

  const secretGate = async (c: Ctx, text: string, tags: string[]): Promise<string[] | null> => {
    const found = scanSecrets(text);
    if (!found.length) return tags;
    const policy = await hub.getSecretScan(c.params.space);
    if (policy === "off") return tags;
    if (policy === "block") {
      json(c.res, 422, { error: "possible secret detected", code: "secret_suspected", patterns: found });
      return null;
    }
    return [...new Set([...tags, SECRET])];
  };

  // --- notes ---
  route("POST", "/spaces/:space/notes", async (c) => {
    if (!(await require(c, "write"))) return;
    const fields = { ...(c.body ?? {}) };
    fields.props = { ...(fields.props ?? {}), authoredBy: stamp(c.principal.kind) };
    const isGated = await gated(c);
    if (isGated) fields.tags = [...new Set([...(fields.tags ?? []), DRAFT])];
    const scanned = await secretGate(c, `${fields.title ?? ""}\n${fields.body ?? ""}\n${JSON.stringify(fields.props ?? {})}`, fields.tags ?? []);
    if (scanned === null) return;
    fields.tags = scanned;
    if (!inScope(c, fields.tags ?? [], fields.props?.path)) return;
    if (await facetError(c, fields.tags ?? [])) return;
    if (!(await hub.hasNote(c.params.space, c.body?.id ?? "")) && (await hub.quotaExceeded(c.params.space))) {
      c.res.writeHead(429, { "content-type": "application/json" });
      return c.res.end(JSON.stringify({ error: "space note quota reached", code: "quota_exceeded" }));
    }
    const id = await hub.createNote(c.params.space, fields, c.body?.id, c.principal.id);
    json(c.res, 201, { id, draft: isGated });
  });
  route("GET", "/spaces/:space/notes", async (c) => {
    if (!(await require(c, "read"))) return;
    const drafts = c.url.searchParams.get("drafts") === "1";
    json(c.res, 200, { notes: await hub.listNotes(c.params.space, intParam(c.url.searchParams.get("limit"), 50, 1, 500), drafts, tagFilters(c)) });
  });
  route("GET", "/spaces/:space/notes/:id", async (c) => {
    if (!(await require(c, "read"))) return;
    if (!(await hub.hasNote(c.params.space, c.params.id))) return err(c.res, 404, "not found");
    json(c.res, 200, await hub.getNoteSnapshot(c.params.space, c.params.id));
  });
  route("PATCH", "/spaces/:space/notes/:id", async (c) => {
    if (!(await require(c, "write"))) return;
    if (!(await hub.hasNote(c.params.space, c.params.id))) return err(c.res, 404, "not found");
    const patch = { ...(c.body ?? {}) };
    const cur0 = await hub.getNoteSnapshot(c.params.space, c.params.id);
    if (patch.title !== undefined || patch.body !== undefined || patch.props !== undefined) {
      const scanned = await secretGate(c, `${patch.title ?? ""}\n${patch.body ?? ""}\n${patch.props ? JSON.stringify(patch.props) : ""}`, patch.tags ?? cur0.tags);
      if (scanned === null) return;
      if (scanned.includes(SECRET)) patch.tags = scanned;
    }
    if (!inScope(c, patch.tags ?? cur0.tags, (patch.props?.path ?? cur0.props.path) as string)) return;
    if (await gated(c)) {
      if (!cur0.tags.includes(DRAFT)) return err(c.res, 403, "agents may only edit #draft notes");
      if (patch.tags && !patch.tags.includes(DRAFT)) patch.tags = [...patch.tags, DRAFT];
      patch.props = { ...(patch.props ?? {}), authoredBy: "agent" };
    }
    if (patch.tags !== undefined && (await facetError(c, patch.tags))) return;
    await hub.patchNote(c.params.space, c.params.id, patch, c.principal.id);
    json(c.res, 200, await hub.getNoteSnapshot(c.params.space, c.params.id));
  });
  route("POST", "/spaces/:space/notes/:id/promote", async (c) => {
    if (!(await require(c, "write"))) return;
    if (c.principal.kind === "agent") return err(c.res, 403, "agents cannot promote drafts");
    if (!(await hub.hasNote(c.params.space, c.params.id))) return err(c.res, 404, "not found");
    const cur = await hub.getNoteSnapshot(c.params.space, c.params.id);
    await hub.patchNote(c.params.space, c.params.id, { tags: cur.tags.filter((t) => t !== DRAFT) }, c.principal.id);
    json(c.res, 200, await hub.getNoteSnapshot(c.params.space, c.params.id));
  });
  route("DELETE", "/spaces/:space/notes/:id", async (c) => {
    if (!(await require(c, "write"))) return;
    if (!(await hub.hasNote(c.params.space, c.params.id))) return err(c.res, 404, "not found");
    const cur = await hub.getNoteSnapshot(c.params.space, c.params.id);
    if (!inScope(c, cur.tags, cur.props.path as string)) return;
    await hub.deleteNote(c.params.space, c.params.id, c.principal.id);
    json(c.res, 200, { ok: true });
  });
  route("POST", "/spaces/:space/notes/:id/purge", async (c) => {
    if (!(await require(c, "admin"))) return;
    console.error(`[audit] purge ${c.params.space}/${c.params.id} by ${c.principal.id} at ${new Date().toISOString()}`);
    await hub.purgeNote(c.params.space, c.params.id);
    json(c.res, 200, { ok: true, purged: c.params.id });
  });

  route("POST", "/spaces/:space/revert", async (c) => {
    if (!(await require(c, "admin"))) return;
    const { principalId, since } = c.body ?? {};
    if (!principalId) return err(c.res, 400, "principalId required");
    if (since === undefined || since === null || since === "") return err(c.res, 400, "since required (epoch ms or ISO timestamp)");
    const sinceTs = typeof since === "number" ? since : Date.parse(since);
    if (Number.isNaN(sinceTs)) return err(c.res, 400, "since must be epoch ms or an ISO timestamp");
    console.error(`[audit] revert ${c.params.space} actor=${principalId} since=${new Date(sinceTs).toISOString()} by ${c.principal.id}`);
    json(c.res, 200, await hub.revertActor(c.params.space, principalId, sinceTs));
  });

  // --- links & traversal --- (a link mutates `from`, so scope-check `from`)
  const linkScoped = async (c: Ctx, from: string): Promise<boolean> => {
    if (!(await hub.hasNote(c.params.space, from))) return true; // new stub source — allow
    const cur = await hub.getNoteSnapshot(c.params.space, from);
    return inScope(c, cur.tags, cur.props.path as string);
  };
  route("POST", "/spaces/:space/links", async (c) => {
    if (!(await require(c, "write"))) return;
    const { from, to, type } = c.body ?? {};
    if (!from || !to) return err(c.res, 400, "from + to required");
    if (!(await linkScoped(c, from))) return;
    await hub.linkNote(c.params.space, from, to, type ?? null, c.principal.id);
    json(c.res, 201, { ok: true });
  });
  route("POST", "/spaces/:space/unlink", async (c) => {
    if (!(await require(c, "write"))) return;
    const { from, to, type } = c.body ?? {};
    if (!from || !to) return err(c.res, 400, "from + to required");
    if (!(await linkScoped(c, from))) return;
    await hub.unlinkNote(c.params.space, from, to, type ?? null, c.principal.id);
    json(c.res, 200, { ok: true });
  });
  route("GET", "/spaces/:space/notes/:id/neighbors", async (c) => {
    if (!(await require(c, "read"))) return;
    const hops = intParam(c.url.searchParams.get("hops"), 1, 0, 6);
    const dir = (c.url.searchParams.get("dir") ?? "both") as "out" | "in" | "both";
    json(c.res, 200, await hub.neighbors(c.params.space, c.params.id, hops, dir));
  });
  route("GET", "/spaces/:space/notes/:id/backlinks", async (c) => {
    if (!(await require(c, "read"))) return;
    json(c.res, 200, await hub.backlinks(c.params.space, c.params.id));
  });

  // --- search, tags, query ---
  route("GET", "/spaces/:space/search", async (c) => {
    if (!(await require(c, "read"))) return;
    const q = c.url.searchParams.get("q") ?? "";
    const limit = intParam(c.url.searchParams.get("limit"), 20, 1, 200);
    const drafts = c.url.searchParams.get("drafts") === "1";
    const mode = (c.url.searchParams.get("mode") ?? "text") as "text" | "semantic" | "hybrid";
    json(c.res, 200, { hits: q ? await hub.searchMode(c.params.space, q, mode, limit, drafts, tagFilters(c)) : [] });
  });
  // Composed retrieval: a token-budgeted context bundle (hybrid search + 1-hop
  // graph expansion), so an agent grounds an answer in one call instead of
  // stitching search + neighbors + get_note itself (03 §4).
  route("POST", "/spaces/:space/context", async (c) => {
    if (!(await require(c, "read"))) return;
    const b = c.body ?? {};
    const query = typeof b.query === "string" ? b.query.trim() : "";
    if (!query) return err(c.res, 400, "query required");
    const clamp = (v: unknown, def: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, Number.isFinite(v) ? Math.floor(v as number) : def));
    const mode = (["text", "semantic", "hybrid"].includes(b.mode) ? b.mode : "hybrid") as "text" | "semantic" | "hybrid";
    json(
      c.res,
      200,
      await hub.getContext(c.params.space, query, {
        tokenBudget: clamp(b.tokenBudget, 2000, 100, 32000),
        mode,
        hops: clamp(b.hops, 1, 0, 3),
        seeds: clamp(b.seeds, 8, 1, 50),
        includeDrafts: b.drafts === true,
        tagFilters: Array.isArray(b.tags) ? b.tags : tagFilters(c),
      }),
    );
  });
  route("GET", "/spaces/:space/tags", async (c) => {
    if (!(await require(c, "read"))) return;
    json(c.res, 200, { tags: await hub.tagCounts(c.params.space) });
  });
  route("POST", "/spaces/:space/query", async (c) => {
    if (!(await require(c, "read"))) return;
    const m = c.body?.match ?? {};
    const tr = c.body?.traverse;
    if (tr?.from) return json(c.res, 200, await hub.neighbors(c.params.space, tr.from, tr.hops ?? 1, tr.dir ?? "both"));
    const limit = c.body?.limit ?? 20;
    const drafts = !!c.body?.includeDrafts;
    const tags: string[] = Array.isArray(m.tags) ? m.tags : [];
    if (m.semantic) return json(c.res, 200, { hits: await hub.searchHybrid(c.params.space, m.semantic, limit, drafts, tags) });
    if (m.text) return json(c.res, 200, { hits: await hub.search(c.params.space, m.text, limit, drafts, tags) });
    err(c.res, 400, "query needs match.text, match.semantic, or traverse.from");
  });

  // --- attachments / blob store (Track D) ---
  // Inline-safe response types: a small image allowlist that EXCLUDES SVG (which can
  // execute script). Everything else is served as an opaque download, so an uploaded
  // text/html or image/svg+xml can't be a same-origin stored-XSS primitive.
  const SAFE_INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon"]);

  // Upload: raw binary body, content-type from the header. Write-gated. Returns the
  // content-addressed handle + the URL a note's markdown references.
  route("POST", "/spaces/:space/blobs", async (c) => {
    if (!(await require(c, "write"))) return;
    if (!c.rawBody.length) return err(c.res, 400, "empty blob");
    const type = (String(c.req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim()) || "application/octet-stream";
    try {
      const meta = await hub.putBlob(c.params.space, new Uint8Array(c.rawBody), type);
      return json(c.res, 201, { ...meta, url: `/v1/spaces/${encodeURIComponent(c.params.space)}/blobs/${meta.hash}` });
    } catch (e) {
      const msg = (e as Error).message;
      // 413 for the per-object size cap, 507 for the per-space budget, 500 otherwise
      const code = /exceeds .* limit|empty/.test(msg) ? 413 : /budget|quota/i.test(msg) ? 507 : 500;
      return err(c.res, code, msg);
    }
  });
  // Download: read-gated; immutable-cacheable + ETag'd. The stored content-type is
  // honored ONLY for inline-safe types; all else downloads as octet-stream. `nosniff`
  // stops the browser MIME-sniffing a mislabeled blob into an executable type.
  route("GET", "/spaces/:space/blobs/:hash", async (c) => {
    if (!(await require(c, "read"))) return;
    const blob = await hub.getBlob(c.params.space, c.params.hash);
    if (!blob) return err(c.res, 404, "no such blob");
    const inline = SAFE_INLINE.has(blob.type);
    c.res.writeHead(200, {
      "content-type": inline ? blob.type : "application/octet-stream",
      "content-length": String(blob.bytes.byteLength),
      "content-disposition": inline ? "inline" : "attachment",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
      etag: `"${c.params.hash}"`,
    });
    c.res.end(Buffer.from(blob.bytes));
  });
  // Admin: reclaim orphaned blobs (mark-and-sweep over live note references). Blobs
  // are dedupe-shared and note delete/purge doesn't touch them, so run this to GC.
  route("POST", "/spaces/:space/blobs/gc", async (c) => {
    if (!(await require(c, "admin"))) return;
    return json(c.res, 200, await hub.gcBlobs(c.params.space));
  });
  // Admin: delete a single blob by hash (targeted reclamation; `gc` does it in bulk).
  route("DELETE", "/spaces/:space/blobs/:hash", async (c) => {
    if (!(await require(c, "admin"))) return;
    await hub.deleteBlob(c.params.space, c.params.hash);
    return json(c.res, 200, { deleted: c.params.hash });
  });

  const maxBody = opts.maxBodyBytes ?? 1_000_000;
  const maxBlob = opts.maxBlobBytes ?? 25 * 1024 * 1024;
  const isBlobUpload = (m: string | undefined, p: string) => m === "POST" && /^\/v1\/spaces\/[^/]+\/blobs\/?$/.test(p);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // metrics + structured request log on response completion (covers every path,
    // incl. the early returns below)
    if (opts.metrics || opts.log) {
      const t0 = Date.now();
      res.on("finish", () => {
        opts.metrics?.record(res.statusCode);
        if (opts.log) {
          console.log(JSON.stringify({ t: "req", ts: new Date().toISOString(), method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - t0 }));
        }
      });
    }

    // unauthenticated liveness check (for containers/orchestration)
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
    }
    // unauthenticated Prometheus metrics (scrape over an internal network)
    if (url.pathname === "/metrics" && opts.metrics) {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      return res.end(opts.metrics.render());
    }

    // Authenticate + rate-limit BEFORE buffering the body — both depend only on
    // request headers, so an unauthenticated or throttled client is shed without
    // first reading its (up to maxBody) payload. The IncomingMessage stays paused
    // until we attach the "data" listener below, so no body bytes are lost.
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const principal = await auth.authenticate(token);
    if (!principal) return err(res, 401, "unauthorized");
    if (limiter && !limiter.allow(token!)) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      return res.end(JSON.stringify({ error: "rate limited", code: "rate_limited" }));
    }
    const caps = await auth.capabilities(token);

    // Buffer raw bytes (so binary blob uploads survive); blob uploads get the larger
    // cap. JSON is parsed lazily below only for JSON-typed bodies.
    const cap = isBlobUpload(req.method, url.pathname) ? maxBlob : maxBody;
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on("data", (d: Buffer) => {
      if (aborted) return;
      total += d.length;
      if (total > cap) {
        aborted = true;
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "request body too large", code: "payload_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", async () => {
      if (aborted) return;
      const rawBody = Buffer.concat(chunks);
      const ctype = (req.headers["content-type"] ?? "").toLowerCase();
      let body: any = undefined;
      // parse JSON only for JSON (or untyped) bodies — a binary upload must not 400
      if (rawBody.length && (!ctype || ctype.includes("json"))) {
        try {
          body = JSON.parse(rawBody.toString("utf8"));
        } catch {
          return err(res, 400, "invalid json");
        }
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params: Record<string, string> = {};
        try {
          r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        } catch {
          return err(res, 400, "malformed percent-encoding in path");
        }
        try {
          return await r.handler({ req, res, url, params, body, rawBody, principal, caps });
        } catch (e) {
          if (!res.headersSent) return err(res, 500, (e as Error).message);
          return;
        }
      }
      err(res, 404, "no route");
    });
  });
  return server;
}
