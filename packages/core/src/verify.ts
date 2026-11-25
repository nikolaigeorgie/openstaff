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
    // What was in front comes from one device as a whole, never mixed.
    const front = nextWeight > prevWeight && r.app ? r : prev.app ? prev : r;
    byMinute.set(r.m, {
      m: r.m,
      title: front.title,
      path: front.path,
      repo: front.repo ?? prev.repo ?? r.repo,
      call: Boolean(prev.call || r.call),
      claudeProjects: [...new Set([...(prev.claudeProjects ?? []), ...(r.claudeProjects ?? [])])],
      commitRepos: [...new Set([...(prev.commitRepos ?? []), ...(r.commitRepos ?? [])])],
      keys: prev.keys + r.keys,
      clicks: prev.clicks + r.clicks,
      moves: prev.moves + r.moves,
      app: front.app ?? prev.app ?? r.app,
      domain: front.app ? front.domain : prev.domain ?? r.domain,
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
 *  3. Claude is working on their prompt and it is within `claudeGraceMinutes` of the last input, or
 *  4. they are on a call.
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
  let silentCall = 0;
  let prevM = Number.NEGATIVE_INFINITY;
  for (const r of sorted) {
    if (!r.call || r.paused || hasInput(r) || r.m - prevM > 5) silentCall = 0;
    prevM = r.m;
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
    if (r.call) {
      silentCall++;
      out.push({ ...r, status: "meeting", verified: true, longCall: silentCall > opts.silentCallMinutes });
    } else if (since <= opts.graceMinutes) {
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
    // An ordinary call needs no typing to count; a very long silent one does not get that pass.
    else if (
      counted.filter((v) => v.status !== "meeting" || v.longCall).length >= 20 &&
      keys === 0 && clicks === 0 && prompts === 0 && commits === 0
    )
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
  /** Counted minutes by kind. */
  activeMinutes: number;
  graceMinutes: number;
  claudeMinutes: number;
  meetingMinutes: number;
  /** Time on the person's own private projects, not counted for the company. */
  personalMinutes: number;
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
    activeMinutes: minutes.filter((v) => v.verified && v.status === "active").length,
    graceMinutes: minutes.filter((v) => v.verified && v.status === "grace").length,
    claudeMinutes: minutes.filter((v) => v.verified && v.status === "claude").length,
    meetingMinutes: minutes.filter((v) => v.verified && v.status === "meeting").length,
    personalMinutes: minutes.filter((v) => v.status === "personal").length,
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
