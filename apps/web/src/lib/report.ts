import {
  DEFAULT_VERIFY,
  addDays,
  dayOfMinute,
  minuteRangeOfDay,
  summarizeHours,
  totals,
  verifyMinutes,
  type HourSummary,
  type MinuteRecord,
  type Period,
  type Totals,
  type VerifiedMinute,
} from "@openstaff/core";
import { and, asc, eq, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Member, Org } from "./auth";

const LOOKBACK = DEFAULT_VERIFY.claudeGraceMinutes;

/** Verified minutes for people in [fromM, toM). Looks back a little so grace carries over the edge. */
async function verifiedInRange(memberIds: string[], fromM: number, toM: number) {
  const out = new Map<string, VerifiedMinute[]>(memberIds.map((id) => [id, []]));
  if (memberIds.length === 0) return out;
  const range = <T extends { memberId: unknown; m: unknown }>(t: T) =>
    and(inArray(t.memberId as never, memberIds), gte(t.m as never, fromM - LOOKBACK), lt(t.m as never, toM));
  const [inputRows, claudeRows, commitRows] = await Promise.all([
    db.select().from(schema.minutes).where(range(schema.minutes)),
    db.select().from(schema.claudeUsage).where(range(schema.claudeUsage)),
    db.select().from(schema.commits).where(range(schema.commits)),
  ]);
  // One list of records per person. Input rows come from the tracker; Claude usage and commits
  // are laid on top, and create a record of their own when the tracker was not running.
  const raw = new Map<string, MinuteRecord[]>();
  const blank = (m: number): MinuteRecord => ({
    m, keys: 0, clicks: 0, moves: 0, claudePrompts: 0, claudeActive: false, tokens: 0, commits: 0, paused: false,
  });
  const push = (memberId: string, r: MinuteRecord) => {
    const list = raw.get(memberId);
    if (list) list.push(r);
    else raw.set(memberId, [r]);
  };
  const paused = new Set<string>();
  for (const r of inputRows) {
    if (r.paused) paused.add(`${r.memberId}:${r.m}`);
    push(r.memberId, { ...blank(r.m), keys: r.keys, clicks: r.clicks, moves: r.moves, app: r.app, domain: r.domain, paused: r.paused });
  }
  for (const c of claudeRows) {
    push(c.memberId, { ...blank(c.m), claudePrompts: c.prompts, tokens: c.tokens, claudeActive: true, paused: paused.has(`${c.memberId}:${c.m}`) });
  }
  for (const c of commitRows) {
    push(c.memberId, { ...blank(c.m), commits: 1, paused: paused.has(`${c.memberId}:${c.m}`) });
  }
  for (const [memberId, list] of raw) {
    out.set(memberId, verifyMinutes(list).filter((v) => v.m >= fromM));
  }
  return out;
}

export interface Usage {
  name: string;
  minutes: number;
}

export interface DayReport {
  day: string;
  fromM: number;
  toM: number;
  minutes: VerifiedMinute[];
  hours: HourSummary[];
  totals: Totals;
  apps: Usage[];
  sites: Usage[];
  claude: { project: string; prompts: number; tokens: number; sessions: number }[];
  commits: (typeof schema.commits.$inferSelect)[];
  adjustments: (typeof schema.adjustments.$inferSelect)[];
}

function usage(minutes: VerifiedMinute[], key: (v: VerifiedMinute) => string | null | undefined): Usage[] {
  const map = new Map<string, number>();
  for (const v of minutes) {
    if (!v.verified) continue;
    const k = key(v);
    if (k) map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].map(([name, minutes]) => ({ name, minutes })).sort((a, b) => b.minutes - a.minutes);
}

export async function dayReport(member: Member, org: Org, day: string): Promise<DayReport> {
  const [fromM, toM] = minuteRangeOfDay(day, org.timezone);
  const minutes = (await verifiedInRange([member.id], fromM, toM)).get(member.id) ?? [];
  const inRange = <T extends { memberId: unknown; m: unknown }>(t: T) =>
    and(eq(t.memberId as never, member.id), gte(t.m as never, fromM), lt(t.m as never, toM));
  const [claudeRows, commitRows, adjustmentRows] = await Promise.all([
    db.select().from(schema.claudeUsage).where(inRange(schema.claudeUsage)),
    db.select().from(schema.commits).where(inRange(schema.commits)).orderBy(asc(schema.commits.m)),
    db
      .select()
      .from(schema.adjustments)
      .where(and(eq(schema.adjustments.memberId, member.id), eq(schema.adjustments.day, day))),
  ]);
  const projects = new Map<string, { prompts: number; tokens: number; sessions: Set<string> }>();
  for (const c of claudeRows) {
    const p = projects.get(c.project) ?? { prompts: 0, tokens: 0, sessions: new Set<string>() };
    p.prompts += c.prompts;
    p.tokens += c.tokens;
    p.sessions.add(c.sessionId);
    projects.set(c.project, p);
  }
  return {
    day,
    fromM,
    toM,
    minutes,
    hours: summarizeHours(minutes),
    totals: totals(minutes),
    apps: usage(minutes, (v) => v.app),
    sites: usage(minutes, (v) => v.domain),
    claude: [...projects.entries()]
      .map(([project, p]) => ({ project, prompts: p.prompts, tokens: p.tokens, sessions: p.sessions.size }))
      .sort((a, b) => b.tokens - a.tokens),
    commits: commitRows,
    adjustments: adjustmentRows,
  };
}

export interface PeriodRow {
  memberId: string;
  name: string;
  hourlyRateCents: number;
  /** Verified minutes per day, in period order. */
  days: number[];
  verifiedMinutes: number;
  weakMinutes: number;
  adjustmentMinutes: number;
  payableMinutes: number;
  amountCents: number;
  claudePrompts: number;
  commits: number;
}

export function periodDays(period: Period): string[] {
  const days: string[] = [];
  for (let d = period.start; d <= period.end; d = addDays(d, 1)) days.push(d);
  return days;
}

export async function periodReport(org: Org, period: Period): Promise<PeriodRow[]> {
  const members = await activeMembers(org.id);
  const ids = members.map((m) => m.id);
  const days = periodDays(period);
  const fromM = minuteRangeOfDay(period.start, org.timezone)[0];
  const toM = minuteRangeOfDay(period.end, org.timezone)[1];
  const verified = await verifiedInRange(ids, fromM, toM);
  const adjustments = ids.length
    ? await db
        .select()
        .from(schema.adjustments)
        .where(
          and(
            inArray(schema.adjustments.memberId, ids),
            gte(schema.adjustments.day, period.start),
            lte(schema.adjustments.day, period.end),
          ),
        )
    : [];
  return members.map((member) => {
    const minutes = verified.get(member.id) ?? [];
    const perDay = new Map<string, number>();
    for (const v of minutes) {
      if (!v.verified) continue;
      const d = dayOfMinute(v.m, org.timezone);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    const t = totals(minutes);
    const adjustmentMinutes = adjustments
      .filter((a) => a.memberId === member.id)
      .reduce((n, a) => n + a.minutes, 0);
    const payableMinutes = Math.max(0, t.verifiedMinutes + adjustmentMinutes);
    return {
      memberId: member.id,
      name: member.name,
      hourlyRateCents: member.hourlyRateCents,
      days: days.map((d) => perDay.get(d) ?? 0),
      verifiedMinutes: t.verifiedMinutes,
      weakMinutes: t.weakMinutes,
      adjustmentMinutes,
      payableMinutes,
      amountCents: Math.round((payableMinutes / 60) * member.hourlyRateCents),
      claudePrompts: t.claudePrompts,
      commits: t.commits,
    };
  });
}

export interface TeamRow {
  member: Member;
  /** working: counted minute in the last few minutes. idle: tracker on, no work. offline: no tracker signal. */
  state: "working" | "idle" | "paused" | "offline" | "never";
  lastSeenAt: Date | null;
  app: string | null;
  domain: string | null;
  today: Totals;
  /** Verified minutes for each hour of today, 24 entries. */
  hourly: number[];
}

export async function activeMembers(orgId: string) {
  return db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.orgId, orgId), isNull(schema.members.archivedAt)))
    .orderBy(asc(schema.members.name));
}

export async function teamReport(org: Org, nowMs = Date.now()): Promise<TeamRow[]> {
  const members = await activeMembers(org.id);
  const ids = members.map((m) => m.id);
  const nowM = Math.floor(nowMs / 60_000);
  const today = dayOfMinute(nowM, org.timezone);
  const [fromM, toM] = minuteRangeOfDay(today, org.timezone);
  const verified = await verifiedInRange(ids, fromM, toM);
  const devices = ids.length
    ? await db.select().from(schema.devices).where(inArray(schema.devices.memberId, ids))
    : [];
  return members.map((member) => {
    const minutes = verified.get(member.id) ?? [];
    const mine = devices.filter((d) => d.memberId === member.id && !d.revokedAt);
    const lastSeenAt = mine.reduce<Date | null>(
      (best, d) => (d.lastSeenAt && (!best || d.lastSeenAt > best) ? d.lastSeenAt : best),
      null,
    );
    const last = minutes[minutes.length - 1];
    const recent = last && nowM - last.m <= 3 ? last : null;
    let state: TeamRow["state"] = "offline";
    if (mine.length === 0) state = "never";
    else if (recent?.status === "paused") state = "paused";
    else if (recent?.verified) state = "working";
    else if (recent || (lastSeenAt && nowMs - lastSeenAt.getTime() < 5 * 60_000)) state = "idle";
    const hourly = Array.from({ length: 24 }, () => 0);
    for (const v of minutes) {
      if (v.verified) hourly[Math.min(23, Math.floor((v.m - fromM) / 60))]++;
    }
    return {
      member,
      state,
      lastSeenAt,
      app: recent?.app ?? null,
      domain: recent?.domain ?? null,
      today: totals(minutes),
      hourly,
    };
  });
}
