import { describe, expect, it } from "vitest";
import { dayOfMinute, minuteRangeOfDay, periodFor } from "./periods";
import type { MinuteRecord } from "./types";
import { mergeMinutes, summarizeHours, totals, verifyMinutes } from "./verify";

const base = 29_000_000 - (29_000_000 % 60); // start of some hour
function rec(offset: number, p: Partial<MinuteRecord> = {}): MinuteRecord {
  return {
    m: base + offset,
    keys: 0,
    clicks: 0,
    moves: 0,
    claudePrompts: 0,
    claudeActive: false,
    tokens: 0,
    commits: 0,
    paused: false,
    ...p,
  };
}
const idleRun = (from: number, to: number, p: Partial<MinuteRecord> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => rec(from + i, p));

describe("verifyMinutes", () => {
  it("counts input minutes and a 5 minute grace, then goes idle", () => {
    const v = verifyMinutes([rec(0, { keys: 40 }), ...idleRun(1, 10)]);
    expect(v.map((x) => x.status)).toEqual([
      "active", "grace", "grace", "grace", "grace", "grace", "idle", "idle", "idle", "idle", "idle",
    ]);
    expect(totals(v).verifiedMinutes).toBe(6);
  });

  it("extends to 15 minutes while Claude is working, but not beyond", () => {
    const v = verifyMinutes([
      rec(0, { keys: 10, claudePrompts: 1 }),
      ...idleRun(1, 30, { claudeActive: true }),
    ]);
    expect(v.filter((x) => x.verified).length).toBe(16);
    expect(v[15].status).toBe("claude");
    expect(v[16].status).toBe("idle");
  });

  it("does not count Claude running with nobody there", () => {
    const v = verifyMinutes(idleRun(0, 59, { claudeActive: true, tokens: 5000 }));
    expect(totals(v).verifiedMinutes).toBe(0);
  });

  it("never counts paused minutes, even with input", () => {
    const v = verifyMinutes([rec(0, { keys: 5 }), rec(1, { keys: 50, paused: true }), rec(2)]);
    expect(v.map((x) => x.status)).toEqual(["active", "paused", "grace"]);
  });

  it("does not bridge a gap where the tracker was not running", () => {
    const v = verifyMinutes([rec(0, { keys: 5 }), rec(3), rec(200)]);
    expect(v.map((x) => x.verified)).toEqual([true, true, false]);
    expect(totals(v).verifiedMinutes).toBe(2);
  });

  it("does not double count two devices in the same minute", () => {
    const merged = mergeMinutes([rec(0, { keys: 5, app: "Code" }), rec(0, { keys: 20, app: "Chrome" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].keys).toBe(25);
    expect(merged[0].app).toBe("Chrome");
    expect(totals(verifyMinutes([rec(0, { keys: 5 }), rec(0, { keys: 20 })])).verifiedMinutes).toBe(1);
  });

  it("is unaffected by input order", () => {
    const a = [rec(0, { keys: 1 }), rec(1), rec(2, { clicks: 1 })];
    expect(verifyMinutes([...a].reverse())).toEqual(verifyMinutes(a));
  });
});

describe("summarizeHours", () => {
  it("flags mouse-move-only hours as weak", () => {
    const h = summarizeHours(verifyMinutes(idleRun(0, 59, { moves: 30 })));
    expect(h).toEqual([{ h: base / 60, verifiedMinutes: 60, evidence: "weak" }]);
  });

  it("marks typing plus Claude as strong", () => {
    const h = summarizeHours(verifyMinutes([rec(0, { keys: 80, claudePrompts: 2 }), rec(1, { keys: 10 })]));
    expect(h[0].evidence).toBe("strong");
  });

  it("marks plain typing as normal", () => {
    const h = summarizeHours(verifyMinutes(idleRun(0, 30, { keys: 10, moves: 5 })));
    expect(h[0].evidence).toBe("normal");
  });

  it("reports weak minutes in totals", () => {
    const t = totals(verifyMinutes([...idleRun(0, 59, { moves: 9 }), ...idleRun(60, 119, { keys: 9 })]));
    expect(t.verifiedMinutes).toBe(120);
    expect(t.weakMinutes).toBe(60);
  });
});

describe("periods", () => {
  it("finds the two-week period for a day", () => {
    expect(periodFor("2026-11-15", "2026-11-02")).toEqual({ index: 0, start: "2026-11-02", end: "2026-11-15" });
    expect(periodFor("2026-11-16", "2026-11-02")).toEqual({ index: 1, start: "2026-11-16", end: "2026-11-29" });
    expect(periodFor("2026-11-01", "2026-11-02").index).toBe(-1);
  });

  it("maps minutes to local days", () => {
    const m = Date.UTC(2026, 10, 15, 3, 30) / 60_000; // 03:30 UTC = 22:30 New York the day before
    expect(dayOfMinute(m, "America/New_York")).toBe("2026-11-14");
    expect(dayOfMinute(m, "UTC")).toBe("2026-11-15");
  });

  it("gives a 24h range for a normal day and handles DST days", () => {
    const [a, b] = minuteRangeOfDay("2026-11-15", "America/New_York");
    expect(b - a).toBe(1440);
    expect(a).toBe(Date.UTC(2026, 10, 15, 5, 0) / 60_000);
    const [c, d] = minuteRangeOfDay("2026-11-01", "America/New_York"); // clocks go back
    expect(d - c).toBe(1500);
  });
});
