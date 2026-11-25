import { describe, expect, it } from "vitest";
import { attributeMinutes, contextKey, type Rule } from "./attribute";
import type { MinuteRecord } from "./types";
import { summarizeHours, totals, verifyMinutes } from "./verify";

const base = 29_000_040 - (29_000_040 % 60);
function rec(offset: number, p: Partial<MinuteRecord> = {}): MinuteRecord {
  return { m: base + offset, keys: 30, clicks: 1, moves: 5, claudePrompts: 0, claudeActive: false, tokens: 0, commits: 0, paused: false, ...p };
}
const run = (from: number, n: number, p: Partial<MinuteRecord> = {}) => Array.from({ length: n }, (_, i) => rec(from + i, p));
const rules: Rule[] = [
  { projectId: "slab", field: "repo", match: "slabdynasty" },
  { projectId: "nami", field: "repo", match: "nami-panel" },
  { projectId: "nami", field: "url", match: "admin.nami.com/panel" },
  { projectId: "web", field: "site", match: "nami.com" },
  { projectId: "nami", field: "title", match: "#nami-dev", app: "Slack" },
  { projectId: "internal", field: "app", match: "Slack" },
];
const sort = (records: MinuteRecord[], a = [] as Parameters<typeof attributeMinutes>[2]) =>
  attributeMinutes(verifyMinutes(records), rules, a);

describe("attributeMinutes", () => {
  it("tries the most specific rule first", () => {
    const v = sort([
      rec(0, { app: "Ghostty", repo: "SlabDynasty" }),
      rec(1, { app: "Chrome", domain: "admin.nami.com", path: "/panel/users" }),
      rec(2, { app: "Chrome", domain: "admin.nami.com", path: "/panelists" }),
      rec(3, { app: "Slack", title: "#nami-dev - Acme - Slack" }),
      rec(4, { app: "Slack", title: "#random - Acme - Slack" }),
      rec(5, { app: "Notes", title: "#nami-dev ideas" }),
    ]);
    expect(v.map((x) => x.projectId)).toEqual(["slab", "nami", "web", "nami", "internal", null]);
  });

  it("lets a correction by hand win, including back to unsorted", () => {
    const v = sort(run(0, 4, { app: "Ghostty", repo: "slabdynasty" }), [
      { fromM: base + 1, toM: base + 3, projectId: "nami" },
      { fromM: base + 2, toM: base + 3, projectId: null },
    ]);
    expect(v.map((x) => x.projectId)).toEqual(["slab", "nami", null, "slab"]);
    expect(v[2].via).toBe("manual");
  });

  it("carries a project over a short detour but not a long one or a change of project", () => {
    const v = sort([
      ...run(0, 5, { repo: "slabdynasty" }),
      ...run(5, 6, { app: "Finder" }),
      ...run(11, 5, { repo: "slabdynasty" }),
      ...run(16, 12, { app: "Finder" }),
      ...run(28, 3, { repo: "slabdynasty" }),
      ...run(31, 3, { app: "Finder" }),
      ...run(34, 3, { repo: "nami-panel" }),
    ]);
    expect(v.slice(5, 11).every((x) => x.projectId === "slab" && x.via === "carry")).toBe(true);
    expect(v.slice(16, 28).every((x) => x.projectId === null)).toBe(true);
    expect(v.slice(31, 34).every((x) => x.projectId === null)).toBe(true);
  });

  it("bills parallel Claude sessions once, to what is in front", () => {
    const v = sort(run(0, 3, { repo: "slabdynasty", claudeActive: true, claudeProjects: ["nami-panel", "slabdynasty"] }));
    expect(v.every((x) => x.projectId === "slab")).toBe(true);
    expect(v[0].background).toEqual(["nami"]);
    expect(totals(v).verifiedMinutes).toBe(3);
  });

  it("falls back to what Claude or a commit was about when nothing in front decides", () => {
    const v = sort([
      rec(0, { app: "Finder", claudeActive: true, claudeProjects: ["nami-panel"] }),
      rec(1, { app: undefined, commits: 1, commitRepos: ["slabdynasty"] }),
    ]);
    expect(v.map((x) => x.projectId)).toEqual(["nami", "slab"]);
  });
});

describe("meetings", () => {
  const quiet = { keys: 0, clicks: 0, moves: 0 };
  it("counts a call with no typing and does not call it thin evidence", () => {
    const v = verifyMinutes(run(0, 60, { ...quiet, call: true, app: "zoom.us" }));
    expect(v.every((x) => x.status === "meeting" && x.verified)).toBe(true);
    expect(totals(v).meetingMinutes).toBe(60);
    expect(totals(v).weakMinutes).toBe(0);
  });
  it("flags a call that stays silent for more than two hours", () => {
    const v = verifyMinutes(run(0, 240, { ...quiet, call: true }));
    expect(v[119].longCall).toBe(false);
    expect(v[120].longCall).toBe(true);
    expect(summarizeHours(v).map((h) => h.evidence)).toEqual(["normal", "normal", "weak", "weak"]);
  });
  it("does not count a call while paused", () => {
    expect(verifyMinutes(run(0, 3, { ...quiet, call: true, paused: true })).every((x) => !x.verified)).toBe(true);
  });
});

describe("contextKey", () => {
  it("names what a minute was about", () => {
    expect(contextKey(rec(0, { app: "Ghostty", repo: "slabdynasty", title: "zsh" }))?.label).toBe("slabdynasty");
    expect(contextKey(rec(0, { app: "Chrome", domain: "github.com", title: "Pull requests" }))).toMatchObject({ field: "site", match: "github.com" });
    expect(contextKey(rec(0, { app: "Slack", title: "nami-dev (Channel) - Acme - Slack" }))).toMatchObject({
      field: "title", app: "Slack", match: "nami-dev (Channel)", label: "Slack · #nami-dev (Acme)",
    });
    expect(contextKey(rec(0, { app: "Slack", title: "Jo Doe (DM) - Slab Dynasty - 35 new items - Slack" }))).toMatchObject({
      label: "Slack · Jo Doe (Slab Dynasty)", wider: { match: "- Slab Dynasty" },
    });
    expect(contextKey(rec(0, { app: "Cursor", title: "page.tsx — nami-site" }))).toMatchObject({ field: "title", match: "nami-site", app: "Cursor" });
    expect(contextKey(rec(0, { app: "Preview" }))).toMatchObject({ field: "app", match: "Preview" });
    expect(contextKey(rec(0, {}))).toBeNull();
  });
});
