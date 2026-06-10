// Pure display-shaping for the review queue (#29) and history (#30). Kept free of
// the DOM so it's unit-testable; app.js renders these into elements.

// Severity-ordered badges for a review item: the gate tags that flagged it, then
// any missing required facets as `needs:<key>`.
export function reviewBadges(item) {
  const order = { "secret-suspected": 0, draft: 1, "needs-facets": 2 };
  const gates = [...(item.gates || [])].sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9));
  return [...gates, ...(item.missingFacets || []).map((f) => `needs:${f}`)];
}

// One-line provenance: who authored it and who last touched it, when.
export function reviewMeta(item) {
  const who = item.authoredBy === "agent" ? "🤖 agent" : "🧑 human";
  const last = item.lastEditedBy ? ` · last by ${item.lastEditedBy}` : "";
  return `${who}${last}${item.lastEditedAt ? ` · ${fmtTime(item.lastEditedAt)}` : ""}`;
}

// A compact, human description of one history entry's change.
export function historyLine(entry) {
  const c = entry.changes || {};
  const parts = [];
  if (c.fields?.includes("title")) parts.push(`title → "${c.title}"`);
  if (c.fields?.includes("body") && typeof c.bodyDelta === "number")
    parts.push(`body ${c.bodyDelta >= 0 ? "+" : ""}${c.bodyDelta} chars`);
  if (c.tagsAdded?.length) parts.push(`+[${c.tagsAdded.join(", ")}]`);
  if (c.tagsRemoved?.length) parts.push(`−[${c.tagsRemoved.join(", ")}]`);
  for (const f of c.fields || []) if (!["title", "body", "tags"].includes(f)) parts.push(f);
  const who = entry.kind ? `${entry.actor} (${entry.kind})` : entry.actor;
  return `${fmtTime(entry.ts)} · ${who}: ${parts.join(", ") || "edited"}`;
}

function fmtTime(ms) {
  // YYYY-MM-DD HH:MM (UTC) — stable, locale-independent (matches tests/server)
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
