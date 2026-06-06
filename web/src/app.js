// Graph explorer UI: search -> graph -> click-to-expand -> live refresh.
import { api, setCreds, liveOpen } from "./api.js";
import { buildGraph, layout, bounds } from "./graph.js";

const $ = (id) => document.getElementById(id);
let disposeLive = () => {};

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
  disposeLive = liveOpen(id, () => focusNote(id)); // live refresh on change
}

function renderNote(n) {
  $("note").innerHTML =
    `<h1>${esc(n.title || n.id)}</h1>` +
    (n.tags?.length ? `<div>${n.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : "") +
    `<pre>${esc(n.body || "(empty)")}</pre>`;
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
