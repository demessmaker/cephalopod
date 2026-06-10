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
  // review queue (#29) + history/blame (#30) + the triage actions
  review: () => req("GET", `/review`),
  history: (id) => req("GET", `/notes/${encodeURIComponent(id)}/history`),
  promote: (id) => req("POST", `/notes/${encodeURIComponent(id)}/promote`),
  purge: (id) => req("POST", `/notes/${encodeURIComponent(id)}/purge`),
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

// A WebSocket transport for a collaborative editor session. `onFrame` receives a
// synthetic { t: "__open" } once connected, then every server frame. Returns
// { send, close, space }. Frames sent before the socket opens are buffered.
export function editorTransport(onFrame) {
  const ws = new WebSocket(wsBase, ["bearer", token]);
  let open = false;
  const backlog = [];
  ws.onopen = () => {
    open = true;
    for (const m of backlog) ws.send(JSON.stringify(m));
    backlog.length = 0;
    onFrame({ t: "__open" });
  };
  ws.onmessage = (e) => {
    try {
      onFrame(JSON.parse(e.data));
    } catch {}
  };
  const send = (m) => (open ? ws.send(JSON.stringify(m)) : backlog.push(m));
  return { send, close: () => ws.close(), space };
}

export const creds = () => ({ token, space, wsBase });
