import {
  DEFAULT_VERIFY,
  type Evidence,
  type HourSummary,
  type MinuteRecord,
  type VerifiedMinute,
  type VerifyOptions,
} from "./types";

export function hasInput(r: MinuteRecord): boolean {
  return r.keys > 0 || r.clicks > 0 || r.moves > 0 || r.claudePrompts > 0 || r.commits > 0;
}

/**
 * Merge records for the same minute from several devices of one person,
 * so two computers running at once never count double.
 */
export function mergeMinutes(records: MinuteRecord[]): MinuteRecord[] {
  const byMinute = new Map<number, MinuteRecord>();
  for (const r of records) {
    const prev = byMinute.get(r.m);
    if (!prev) {
      byMinute.set(r.m, { ...r });
      continue;
    }
    const prevWeight = prev.keys + prev.clicks;
    const nextWeight = r.keys + r.clicks;
    byMinute.set(r.m, {
      m: r.m,
      keys: prev.keys + r.keys,
      clicks: prev.clicks + r.clicks,
      moves: prev.moves + r.moves,
      app: nextWeight > prevWeight ? r.app ?? prev.app : prev.app ?? r.app,
      domain: nextWeight > prevWeight ? r.domain ?? prev.domain : prev.domain ?? r.domain,
      claudePrompts: prev.claudePrompts + r.claudePrompts,
      claudeActive: prev.claudeActive || r.claudeActive,
      tokens: prev.tokens + r.tokens,
      commits: prev.commits + r.commits,
      // Paused only if every device that reported was paused.
      paused: prev.paused && r.paused,
    });
  }
  return [...byMinute.values()].sort((a, b) => a.m - b.m);
}

/**
 * Decide which minutes count as work.
 *
 * A minute counts when the tracker was running and not paused, and:
 *  1. there was human input in it, or
 *  2. it is within `graceMinutes` of the last input, or
 *  3. Claude is working on their prompt and it is within `claudeGraceMinutes` of the last input.
 *
 * Minutes with no record at all (computer asleep, tracker not running) never count.
 */
export function verifyMinutes(
  records: MinuteRecord[],
  opts: VerifyOptions = DEFAULT_VERIFY,
): VerifiedMinute[] {
  const sorted = mergeMinutes(records);
  const out: VerifiedMinute[] = [];
  let lastInput = Number.NEGATIVE_INFINITY;
  for (const r of sorted) {
    if (r.paused) {
      out.push({ ...r, status: "paused", verified: false });
      continue;
    }
    if (hasInput(r)) {
      lastInput = r.m;
      out.push({ ...r, status: "active", verified: true });
      continue;
    }
    const since = r.m - lastInput;
    if (since <= opts.graceMinutes) {
      out.push({ ...r, status: "grace", verified: true });
    } else if (r.claudeActive && since <= opts.claudeGraceMinutes) {
      out.push({ ...r, status: "claude", verified: true });
    } else {
      out.push({ ...r, status: "idle", verified: false });
    }
  }
  return out;
}

/**
 * Label each hour by how well its minutes are backed up.
 *  - strong: typing plus Claude usage or commits
 *  - weak: a good chunk of counted time with mouse movement only (no keys, no clicks,
 *    no Claude, no commits). Typical of a mouse jiggler, or of watching a video.
 *  - normal: everything else
 */
export function summarizeHours(minutes: VerifiedMinute[]): HourSummary[] {
  const hours = new Map<number, VerifiedMinute[]>();
  for (const v of minutes) {
    const h = Math.floor(v.m / 60);
    const list = hours.get(h);
    if (list) list.push(v);
    else hours.set(h, [v]);
  }
  const out: HourSummary[] = [];
  for (const [h, list] of [...hours.entries()].sort((a, b) => a[0] - b[0])) {
    const counted = list.filter((v) => v.verified);
    if (counted.length === 0) continue;
    const keys = sum(counted, (v) => v.keys);
    const clicks = sum(counted, (v) => v.clicks);
    const prompts = sum(counted, (v) => v.claudePrompts);
    const commits = sum(counted, (v) => v.commits);
    let evidence: Evidence = "normal";
    if (keys > 0 && (prompts > 0 || commits > 0)) evidence = "strong";
    else if (counted.length >= 20 && keys === 0 && clicks === 0 && prompts === 0 && commits === 0)
      evidence = "weak";
    out.push({ h, verifiedMinutes: counted.length, evidence });
  }
  return out;
}

export interface Totals {
  verifiedMinutes: number;
  weakMinutes: number;
  pausedMinutes: number;
  idleMinutes: number;
  keys: number;
  clicks: number;
  claudePrompts: number;
  tokens: number;
  commits: number;
}

export function totals(minutes: VerifiedMinute[]): Totals {
  const hours = summarizeHours(minutes);
  return {
    verifiedMinutes: minutes.filter((v) => v.verified).length,
    weakMinutes: sum(hours.filter((h) => h.evidence === "weak"), (h) => h.verifiedMinutes),
    pausedMinutes: minutes.filter((v) => v.status === "paused").length,
    idleMinutes: minutes.filter((v) => v.status === "idle").length,
    keys: sum(minutes, (v) => v.keys),
    clicks: sum(minutes, (v) => v.clicks),
    claudePrompts: sum(minutes, (v) => v.claudePrompts),
    tokens: sum(minutes, (v) => v.tokens),
    commits: sum(minutes, (v) => v.commits),
  };
}

function sum<T>(list: T[], f: (t: T) => number): number {
  let n = 0;
  for (const t of list) n += f(t);
  return n;
}
