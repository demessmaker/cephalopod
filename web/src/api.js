// Same-origin API client (the dev server proxies /v1 to the brain). Live updates
// connect directly to the brain WebSocket.
let token = "", space = "", wsBase = "";

export function setCreds(t, s, w) {
  token = t; space = s; wsBase = w;
}

async function req(method, path, body) {
  const r = await fetch(`/v1/spaces/${encodeURIComponent(space)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

export const api = {
  search: (q, mode = "hybrid", tags = []) =>
    req("GET", `/search?q=${encodeURIComponent(q)}&mode=${mode}` + tags.map((t) => `&tag=${encodeURIComponent(t)}`).join("")),
  note: (id) => req("GET", `/notes/${encodeURIComponent(id)}`),
  neighbors: (id, hops = 1) => req("GET", `/notes/${encodeURIComponent(id)}/neighbors?hops=${hops}`),
  tags: () => req("GET", `/tags`),
};

// Open a live subscription to a note; calls onUpdate() when it changes. Returns
// a disposer. No-op if no WS base configured.
export function liveOpen(noteId, onUpdate) {
  if (!wsBase) return () => {};
  let ws;
  try {
    // auth via the Sec-WebSocket-Protocol subprotocol ("bearer", <token>) so the
    // token never lands in the URL (and thus proxy/access logs or history).
    ws = new WebSocket(wsBase, ["bearer", token]);
  } catch {
    return () => {};
  }
  ws.onopen = () => ws.send(JSON.stringify({ t: "open", space, note: noteId }));
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.t === "update" && m.note === noteId) onUpdate();
    } catch {}
  };
  return () => ws && ws.close();
}
