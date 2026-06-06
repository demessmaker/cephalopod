// WebSocket upgrade auth: prefer the Authorization header (or the
// Sec-WebSocket-Protocol "bearer,<token>" form) over a ?token= query param, so
// secrets stop ending up in URLs/access logs. Query is kept as a fallback for
// browser clients that can't set headers on a WebSocket.
import type { IncomingMessage } from "node:http";

export function tokenFromUpgrade(req: Pick<IncomingMessage, "headers" | "url">): string | undefined {
  const authz = req.headers?.authorization;
  if (authz && /^Bearer\s+/i.test(authz)) return authz.replace(/^Bearer\s+/i, "").trim();

  const proto = req.headers?.["sec-websocket-protocol"];
  if (proto) {
    const parts = String(proto).split(",").map((s) => s.trim());
    const i = parts.indexOf("bearer");
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
  }

  try {
    const t = new URL(req.url ?? "/", "http://x").searchParams.get("token");
    if (t) return t;
  } catch {
    /* malformed url */
  }
  return undefined;
}
