// Graph explorer UI: search -> graph -> click-to-expand -> live refresh + edit.
import { api, setCreds, liveOpen, editorTransport, creds } from "./api.js";
import { buildGraph, layout, bounds } from "./graph.js";
import { NoteSession, bindTextarea } from "./edit.js";

const $ = (id) => document.getElementById(id);
let disposeLive = () => {};
let editor = null; // { session, transport, dispose }
let currentId = null; // the focused note

// a stable per-browser identity for presence
const me = (() => {
  let id = localStorage.getItem("ceph.user");
  if (!id) localStorage.setItem("ceph.user", (id = "u" + Math.random().toString(36).slice(2, 6)));
  const colors = ["#e6194B", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4"];
  return { name: id, color: colors[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length] };
})();

// --- credentials (persisted) ---
for (const k of ["token", "space", "ws"]) $(k).value = localStorage.getItem("ceph." + k) || (k === "ws" ? "ws://localhost:7700" : "");
function connect() {
  for (const k of ["token", "space", "ws"]) localStorage.setItem("ceph." + k, $(k).value);
  setCreds($("token").value.trim(), $("space").value.trim(), $("ws").value.trim());
  $("status").textContent = $("token").value && $("space").value ? `connected to "${$("space").value}"` : "set token + space";
}
$("connect").onclick = connect;
connect();

// --- search ---
async function search() {
  const q = $("q").value.trim();
  if (!q) return;
  try {
    const { hits } = await api.search(q, $("mode").value);
    renderResults(hits);
  } catch (e) {
    $("results").innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}
$("go").onclick = search;
$("q").addEventListener("keydown", (e) => e.key === "Enter" && search());

function renderResults(hits) {
  $("results").innerHTML = hits.length
    ? ""
    : `<p class="muted">No results.</p>`;
  for (const h of hits) {
    const el = document.createElement("div");
    el.className = "result";
    el.innerHTML = `<div class="t">${esc(h.title || h.id)}</div>${(h.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}`;
    el.onclick = () => focusNote(h.id);
    $("results").appendChild(el);
  }
}

// --- focus a note: load it + neighbors, lay out, render, subscribe ---
async function focusNote(id) {
  disposeLive();
  stopEdit();
  currentId = id;
  let note, sub;
  try {
    [note, sub] = await Promise.all([api.note(id), api.neighbors(id, 1)]);
  } catch (e) {
    $("note").innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    return;
  }
  renderNote(note);
  const { nodes, links } = buildGraph(id, sub);
  layout(nodes, links, 350);
  renderGraph(id, nodes, links);
  // live refresh on change — but not while editing (the CRDT session is live already)
  disposeLive = liveOpen(id, () => { if (!editor) focusNote(id); });
}

function renderNote(n) {
  $("note").innerHTML =
    `<h1>${esc(n.title || n.id)}</h1>` +
    (n.tags?.length ? `<div>${n.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : "") +
    `<div class="note-actions"><button id="edit-toggle">✎ Edit</button> <span id="presence" class="muted"></span></div>` +
    `<pre id="body-view">${esc(n.body || "(empty)")}</pre>` +
    `<textarea id="body-edit" class="hidden" spellcheck="false"></textarea>`;
  $("edit-toggle").onclick = () => (editor ? stopEdit(true) : startEdit(n.id));
}

// --- collaborative editing: open a CRDT session over WS, bind the textarea ---
function startEdit(id) {
  if (!creds().wsBase) return;
  const view = $("body-view"), ta = $("body-edit"), btn = $("edit-toggle");
  view.classList.add("hidden");
  ta.classList.remove("hidden");
  btn.textContent = "✓ Done";

  let session;
  const transport = editorTransport((m) => {
    if (m.t === "__open") session.start();
    else if (m.t === "awareness" || m.note === id) session.receive(m);
  });
  session = new NoteSession(transport.send, { space: transport.space, note: id, user: me });
  const unbind = bindTextarea(session, ta);
  const renderPresence = () => {
    const peers = session.peers();
    $("presence").innerHTML = peers.length
      ? "editing: " + peers.map((p) => `<span class="peer" style="color:${esc(p.color || "#888")}">${esc(p.name || "?")}</span>`).join(", ")
      : "";
  };
  session.awareness.on("change", renderPresence);
  ta.addEventListener("keyup", () => session.setCursor(ta.selectionStart));
  ta.addEventListener("click", () => session.setCursor(ta.selectionStart));
  editor = { session, transport, dispose: () => { unbind(); session.destroy(); transport.close(); } };
}

function stopEdit(refresh) {
  if (!editor) return;
  editor.dispose();
  editor = null;
  if (refresh) focusNote(currentId); // re-render the read view from the saved note
}

function renderGraph(focusId, nodes, links) {
  const svg = $("graph");
  const b = bounds(nodes);
  svg.setAttribute("viewBox", `${b.minX} ${b.minY} ${b.w} ${b.h}`);
  const pos = new Map(nodes.map((n) => [n.id, n]));
  let html = "";
  for (const l of links) {
    const a = pos.get(l.source), c = pos.get(l.target);
    if (!a || !c) continue;
    html += `<line class="link" x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" />`;
    if (l.type) html += `<text class="link-label" x="${(a.x + c.x) / 2}" y="${(a.y + c.y) / 2}">${esc(l.type)}</text>`;
  }
  for (const n of nodes) {
    const r = n.id === focusId ? 9 : 6;
    html += `<g class="node ${n.stub ? "stub" : ""}" data-id="${esc(n.id)}">
      <circle cx="${n.x}" cy="${n.y}" r="${r}" />
      <text x="${n.x + r + 2}" y="${n.y + 4}">${esc(n.title || n.id)}</text></g>`;
  }
  svg.innerHTML = html;
  for (const g of svg.querySelectorAll(".node")) g.addEventListener("click", () => focusNote(g.dataset.id));
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
