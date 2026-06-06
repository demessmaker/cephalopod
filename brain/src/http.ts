// HTTP Query/Command API (03 §2). Built on node:http with a tiny router; writes
// funnel through the same hub path as WS deltas, so HTTP and live editors
// converge. Every route is ACL-checked (05 §2).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Auth, can, type Action, type Capabilities } from "./auth.js";
import type { SpaceHub } from "./hub.js";
import type { Principal, Role } from "./store/store.js";
import { RateLimiter } from "./ratelimit.js";
import { scanSecrets } from "./secrets.js";

export interface HttpOptions {
  rateLimit?: { capacity: number; refillPerSec: number }; // per-token request rate
  maxBodyBytes?: number; // reject larger request bodies with 413 (default 1 MiB)
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: any;
  principal: Principal;
  caps: Capabilities;
}
type Handler = (c: Ctx) => void;
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const re = new RegExp(
    "^" + path.replace(/:([A-Za-z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$",
  );
  return { method, re, keys, handler };
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(s);
};
const err = (res: ServerResponse, code: number, msg: string) => json(res, code, { error: msg });

export function createHttpServer(hub: SpaceHub, auth: Auth, opts: HttpOptions = {}) {
  const routes: Route[] = [];
  const route = (m: string, p: string, h: Handler) => routes.push(compile(m, "/v1" + p, h));
  const limiter = opts.rateLimit ? new RateLimiter(opts.rateLimit.capacity, opts.rateLimit.refillPerSec) : undefined;

  // require a space role >= action; also enforces a read-only token capability
  const require = (c: Ctx, action: Action): boolean => {
    const role = auth.roleOf(c.params.space, c.principal.id);
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

  // Minting principals/tokens must not let a capability-restricted token escalate
  // itself (read-only/scoped -> full) — caps may only ever narrow (05 §2.2). Only
  // an unconstrained token may mint; a scoped one is refused.
  const canMint = (c: Ctx): boolean => {
    const cp = c.caps;
    if (cp.mode === "read" || cp.writeTags?.length || cp.pathPrefix) {
      err(c.res, 403, "capability-scoped tokens cannot mint principals or tokens");
      return false;
    }
    return true;
  };

  // --- principals, tokens & spaces ---
  route("POST", "/principals", (c) => {
    if (!canMint(c)) return;
    const kind = c.body?.kind === "agent" ? "agent" : "user";
    const p = auth.createPrincipal(kind, String(c.body?.name ?? kind));
    const caps = parseCaps(c.body?.capabilities);
    json(c.res, 201, { principal: p, token: auth.issueToken(p.id, caps), capabilities: caps });
  });

  // mint an additional (optionally scoped) token for an existing principal
  route("POST", "/tokens", (c) => {
    if (!canMint(c)) return;
    const principalId = c.body?.principalId;
    if (!principalId || !auth.getPrincipalById(principalId)) return err(c.res, 400, "valid principalId required");
    const caps = parseCaps(c.body?.capabilities);
    json(c.res, 201, { token: auth.issueToken(principalId, caps), capabilities: caps });
  });

  route("GET", "/spaces", (c) => json(c.res, 200, { spaces: auth.memberships(c.principal.id) }));

  route("POST", "/spaces", (c) => {
    const name = String(c.body?.name ?? "").trim();
    if (!name) return err(c.res, 400, "name required");
    auth.setRole(name, c.principal.id, "admin"); // creator becomes admin
    json(c.res, 201, { space: name, role: "admin" });
  });

  route("POST", "/spaces/:space/members", (c) => {
    if (!require(c, "admin")) return;
    const { principalId, role } = c.body ?? {};
    if (!principalId || !["viewer", "editor", "admin"].includes(role)) return err(c.res, 400, "principalId + role required");
    auth.setRole(c.params.space, principalId, role as Role);
    json(c.res, 200, { ok: true });
  });

  // per-space settings: agent write policy (05 §4) + required facets
  const settingsOf = (space: string) => ({
    agentMode: hub.getAgentMode(space),
    requiredFacets: hub.getRequiredFacets(space),
    maxNotes: hub.getMaxNotes(space),
    secretScan: hub.getSecretScan(space),
  });
  route("GET", "/spaces/:space/settings", (c) => {
    if (!require(c, "read")) return;
    json(c.res, 200, settingsOf(c.params.space));
  });
  route("PUT", "/spaces/:space/settings", (c) => {
    if (!require(c, "admin")) return;
    const { agentMode, requiredFacets, maxNotes } = c.body ?? {};
    if (agentMode !== undefined) {
      if (agentMode !== "draft" && agentMode !== "open") return err(c.res, 400, "agentMode must be draft|open");
      hub.setAgentMode(c.params.space, agentMode);
    }
    if (requiredFacets !== undefined) {
      if (!Array.isArray(requiredFacets) || requiredFacets.some((f) => typeof f !== "string"))
        return err(c.res, 400, "requiredFacets must be a string[]");
      hub.setRequiredFacets(c.params.space, requiredFacets);
    }
    if (maxNotes !== undefined) {
      if (typeof maxNotes !== "number" || maxNotes < 0) return err(c.res, 400, "maxNotes must be a non-negative number");
      hub.setMaxNotes(c.params.space, maxNotes);
    }
    if (c.body?.secretScan !== undefined) {
      if (!["off", "warn", "block"].includes(c.body.secretScan)) return err(c.res, 400, "secretScan must be off|warn|block");
      hub.setSecretScan(c.params.space, c.body.secretScan);
    }
    json(c.res, 200, settingsOf(c.params.space));
  });

  // Draft-gate (05 §4): agent writes are provenance-stamped and, when the space
  // is in "draft" mode, forced to #draft; agents may only touch their own drafts.
  const DRAFT = "draft";
  const gated = (c: Ctx) => c.principal.kind === "agent" && hub.getAgentMode(c.params.space) === "draft";
  const stamp = (kind: string) => (kind === "agent" ? "agent" : "human");

  // per-space required facets (e.g. client/project), with a #shared exemption
  const facetError = (c: Ctx, tags: string[]): boolean => {
    const miss = hub.missingFacets(c.params.space, tags);
    if (miss.length) {
      err(c.res, 422, `missing required facets: ${miss.join(", ")} — add tags like client:acme, or tag "shared" to exempt`);
      return true;
    }
    return false;
  };
  const tagFilters = (c: Ctx) => c.url.searchParams.getAll("tag");
  const SECRET = "secret-suspected";

  // Scan text for secrets per the space policy. Returns the tags to merge (warn)
  // or sends a 422 and returns null (block). [] = clean / off.
  const secretGate = (c: Ctx, text: string, tags: string[]): string[] | null => {
    const found = scanSecrets(text);
    if (!found.length) return tags;
    const policy = hub.getSecretScan(c.params.space);
    if (policy === "off") return tags;
    if (policy === "block") {
      json(c.res, 422, { error: "possible secret detected", code: "secret_suspected", patterns: found });
      return null;
    }
    return [...new Set([...tags, SECRET])]; // warn: tag it, let it through (hidden if also #draft)
  };

  // --- notes ---
  route("POST", "/spaces/:space/notes", (c) => {
    if (!require(c, "write")) return;
    const fields = { ...(c.body ?? {}) };
    fields.props = { ...(fields.props ?? {}), authoredBy: stamp(c.principal.kind) };
    if (gated(c)) fields.tags = [...new Set([...(fields.tags ?? []), DRAFT])];
    const scanned = secretGate(c, `${fields.title ?? ""}\n${fields.body ?? ""}`, fields.tags ?? []);
    if (scanned === null) return; // blocked
    fields.tags = scanned;
    if (!inScope(c, fields.tags ?? [], fields.props?.path)) return;
    if (facetError(c, fields.tags ?? [])) return;
    if (!hub.hasNote(c.params.space, c.body?.id ?? "") && hub.quotaExceeded(c.params.space)) {
      c.res.writeHead(429, { "content-type": "application/json" });
      return c.res.end(JSON.stringify({ error: "space note quota reached", code: "quota_exceeded" }));
    }
    const id = hub.createNote(c.params.space, fields, c.body?.id, c.principal.id);
    json(c.res, 201, { id, draft: gated(c) });
  });
  route("GET", "/spaces/:space/notes", (c) => {
    if (!require(c, "read")) return;
    const drafts = c.url.searchParams.get("drafts") === "1";
    json(c.res, 200, { notes: hub.listNotes(c.params.space, Number(c.url.searchParams.get("limit") ?? 50), drafts, tagFilters(c)) });
  });
  route("GET", "/spaces/:space/notes/:id", (c) => {
    if (!require(c, "read")) return;
    if (!hub.hasNote(c.params.space, c.params.id)) return err(c.res, 404, "not found");
    json(c.res, 200, hub.getNoteSnapshot(c.params.space, c.params.id));
  });
  route("PATCH", "/spaces/:space/notes/:id", (c) => {
    if (!require(c, "write")) return;
    if (!hub.hasNote(c.params.space, c.params.id)) return err(c.res, 404, "not found");
    const patch = { ...(c.body ?? {}) };
    const cur0 = hub.getNoteSnapshot(c.params.space, c.params.id);
    if (patch.title !== undefined || patch.body !== undefined) {
      const scanned = secretGate(c, `${patch.title ?? ""}\n${patch.body ?? ""}`, patch.tags ?? cur0.tags);
      if (scanned === null) return; // blocked
      if (scanned.includes(SECRET)) patch.tags = scanned;
    }
    if (!inScope(c, patch.tags ?? cur0.tags, (patch.props?.path ?? cur0.props.path) as string)) return;
    if (gated(c)) {
      if (!cur0.tags.includes(DRAFT)) return err(c.res, 403, "agents may only edit #draft notes");
      if (patch.tags && !patch.tags.includes(DRAFT)) patch.tags = [...patch.tags, DRAFT]; // can't self-promote
      patch.props = { ...(patch.props ?? {}), authoredBy: "agent" };
    }
    if (patch.tags !== undefined && facetError(c, patch.tags)) return; // enforce on explicit tag changes
    hub.patchNote(c.params.space, c.params.id, patch, c.principal.id);
    json(c.res, 200, hub.getNoteSnapshot(c.params.space, c.params.id));
  });
  route("POST", "/spaces/:space/notes/:id/promote", (c) => {
    if (!require(c, "write")) return;
    if (c.principal.kind === "agent") return err(c.res, 403, "agents cannot promote drafts");
    if (!hub.hasNote(c.params.space, c.params.id)) return err(c.res, 404, "not found");
    const cur = hub.getNoteSnapshot(c.params.space, c.params.id);
    hub.patchNote(c.params.space, c.params.id, { tags: cur.tags.filter((t) => t !== DRAFT) }, c.principal.id);
    json(c.res, 200, hub.getNoteSnapshot(c.params.space, c.params.id));
  });
  route("DELETE", "/spaces/:space/notes/:id", (c) => {
    if (!require(c, "write")) return;
    if (!hub.hasNote(c.params.space, c.params.id)) return err(c.res, 404, "not found");
    const cur = hub.getNoteSnapshot(c.params.space, c.params.id);
    if (!inScope(c, cur.tags, cur.props.path as string)) return;
    hub.deleteNote(c.params.space, c.params.id, c.principal.id);
    json(c.res, 200, { ok: true });
  });
  // hard purge (05 §5): destructive, admin-only, audited — expunge all traces
  route("POST", "/spaces/:space/notes/:id/purge", (c) => {
    if (!require(c, "admin")) return;
    console.error(`[audit] purge ${c.params.space}/${c.params.id} by ${c.principal.id} at ${new Date().toISOString()}`);
    hub.purgeNote(c.params.space, c.params.id);
    json(c.res, 200, { ok: true, purged: c.params.id });
  });

  // reversibility (05 §4): admin undoes a principal's edits since a time
  route("POST", "/spaces/:space/revert", (c) => {
    if (!require(c, "admin")) return;
    const { principalId, since } = c.body ?? {};
    if (!principalId) return err(c.res, 400, "principalId required");
    // `since` is required: defaulting it to 0 would silently revert the actor's
    // ENTIRE history (every edit has ts >= 0) — a destructive op must be explicit.
    if (since === undefined || since === null || since === "") {
      return err(c.res, 400, "since required (epoch ms or ISO timestamp)");
    }
    const sinceTs = typeof since === "number" ? since : Date.parse(since);
    if (Number.isNaN(sinceTs)) return err(c.res, 400, "since must be epoch ms or an ISO timestamp");
    console.error(`[audit] revert ${c.params.space} actor=${principalId} since=${new Date(sinceTs).toISOString()} by ${c.principal.id}`);
    json(c.res, 200, { reverted: hub.revertActor(c.params.space, principalId, sinceTs) });
  });

  // --- links & traversal --- (a link mutates `from`, so scope-check `from`)
  const linkScoped = (c: Ctx, from: string): boolean => {
    if (!hub.hasNote(c.params.space, from)) return true; // new stub source — allow
    const cur = hub.getNoteSnapshot(c.params.space, from);
    return inScope(c, cur.tags, cur.props.path as string);
  };
  route("POST", "/spaces/:space/links", (c) => {
    if (!require(c, "write")) return;
    const { from, to, type } = c.body ?? {};
    if (!from || !to) return err(c.res, 400, "from + to required");
    if (!linkScoped(c, from)) return;
    hub.linkNote(c.params.space, from, to, type ?? null, c.principal.id);
    json(c.res, 201, { ok: true });
  });
  route("POST", "/spaces/:space/unlink", (c) => {
    if (!require(c, "write")) return;
    const { from, to, type } = c.body ?? {};
    if (!from || !to) return err(c.res, 400, "from + to required");
    if (!linkScoped(c, from)) return;
    hub.unlinkNote(c.params.space, from, to, type ?? null, c.principal.id);
    json(c.res, 200, { ok: true });
  });
  route("GET", "/spaces/:space/notes/:id/neighbors", (c) => {
    if (!require(c, "read")) return;
    const hops = Number(c.url.searchParams.get("hops") ?? 1);
    const dir = (c.url.searchParams.get("dir") ?? "both") as "out" | "in" | "both";
    json(c.res, 200, hub.neighbors(c.params.space, c.params.id, hops, dir));
  });
  route("GET", "/spaces/:space/notes/:id/backlinks", (c) => {
    if (!require(c, "read")) return;
    json(c.res, 200, hub.backlinks(c.params.space, c.params.id));
  });

  // --- search, tags, query ---
  route("GET", "/spaces/:space/search", (c) => {
    if (!require(c, "read")) return;
    const q = c.url.searchParams.get("q") ?? "";
    const limit = Number(c.url.searchParams.get("limit") ?? 20);
    const drafts = c.url.searchParams.get("drafts") === "1";
    const mode = (c.url.searchParams.get("mode") ?? "text") as "text" | "semantic" | "hybrid";
    json(c.res, 200, { hits: q ? hub.searchMode(c.params.space, q, mode, limit, drafts, tagFilters(c)) : [] });
  });
  route("GET", "/spaces/:space/tags", (c) => {
    if (!require(c, "read")) return;
    json(c.res, 200, { tags: hub.tagCounts(c.params.space) });
  });
  route("POST", "/spaces/:space/query", (c) => {
    if (!require(c, "read")) return;
    const m = c.body?.match ?? {};
    const tr = c.body?.traverse;
    if (tr?.from) return json(c.res, 200, hub.neighbors(c.params.space, tr.from, tr.hops ?? 1, tr.dir ?? "both"));
    const limit = c.body?.limit ?? 20;
    const drafts = !!c.body?.includeDrafts;
    const tags: string[] = Array.isArray(m.tags) ? m.tags : [];
    if (m.semantic) return json(c.res, 200, { hits: hub.searchHybrid(c.params.space, m.semantic, limit, drafts, tags) });
    if (m.text) return json(c.res, 200, { hits: hub.search(c.params.space, m.text, limit, drafts, tags) });
    err(c.res, 400, "query needs match.text, match.semantic, or traverse.from");
  });

  const maxBody = opts.maxBodyBytes ?? 1_000_000;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // unauthenticated liveness check (for containers/orchestration)
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
    }

    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const principal = auth.authenticate(token);
    if (!principal) return err(res, 401, "unauthorized");
    if (limiter && !limiter.allow(token!)) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      return res.end(JSON.stringify({ error: "rate limited", code: "rate_limited" }));
    }
    const caps = auth.capabilities(token);

    let raw = "";
    let aborted = false;
    req.on("data", (d) => {
      if (aborted) return;
      raw += d;
      if (raw.length > maxBody) {
        aborted = true;
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "request body too large", code: "payload_too_large" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (aborted) return;
      let body: any = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return err(res, 400, "invalid json");
        }
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        try {
          return r.handler({ req, res, url, params, body, principal, caps });
        } catch (e) {
          return err(res, 500, (e as Error).message);
        }
      }
      err(res, 404, "no route");
    });
  });
  return server;
}
