// Pure display-shaping for the review queue / history panels (#29 / #30).
import { describe, it, expect } from "vitest";
import { reviewBadges, reviewMeta, historyLine } from "../src/review.js";

describe("reviewBadges", () => {
  it("orders gates by severity and appends missing facets", () => {
    const item = { gates: ["draft", "secret-suspected"], missingFacets: ["client", "project"] };
    expect(reviewBadges(item)).toEqual(["secret-suspected", "draft", "needs:client", "needs:project"]);
  });
  it("is empty for a clean item", () => {
    expect(reviewBadges({})).toEqual([]);
  });
});

describe("reviewMeta", () => {
  it("shows agent authorship + last editor + time", () => {
    const s = reviewMeta({ authoredBy: "agent", lastEditedBy: "a_7", lastEditedAt: Date.UTC(2026, 5, 10, 9, 30) });
    expect(s).toContain("🤖 agent");
    expect(s).toContain("last by a_7");
    expect(s).toContain("2026-06-10 09:30");
  });
  it("defaults to human and omits missing fields", () => {
    expect(reviewMeta({ authoredBy: "human" })).toBe("🧑 human");
  });
});

describe("historyLine", () => {
  it("summarizes a title + body change with actor kind", () => {
    const line = historyLine({
      actor: "alice", kind: "user", ts: Date.UTC(2026, 5, 10, 9, 0),
      changes: { fields: ["title", "body"], title: "Design", bodyDelta: 12 },
    });
    expect(line).toContain("alice (user)");
    expect(line).toContain('title → "Design"');
    expect(line).toContain("body +12 chars");
  });
  it("renders tag add/remove and falls back to 'edited'", () => {
    expect(historyLine({ actor: "bob", ts: 0, changes: { fields: ["tags"], tagsAdded: ["draft"], tagsRemoved: ["wip"] } }))
      .toContain("+[draft], −[wip]");
    expect(historyLine({ actor: "sys", ts: 0, changes: { fields: [] } })).toContain("edited");
  });
});
