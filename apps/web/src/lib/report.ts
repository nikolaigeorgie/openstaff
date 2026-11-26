import {
  addDays,
  dayOfMinute,
  minuteRangeOfDay,
  summarizeHours,
  totals,
  verifyMinutes,
  attributeMinutes,
  contextKey,
  type Assignment,
  type AttributedMinute,
  type HourSummary,
  type MinuteRecord,
  type MinuteStatus,
  type Rule,
  type RuleField,
  type Period,
  type Totals,
} from "@openstaff/core";
import { and, asc, eq, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Member, Org } from "./auth";

const LOOKBACK = 30;

/** A minute with its project. `was` keeps how it was backed up when it is personal time. */
export type SortedMinute = AttributedMinute & { personal: boolean; was: MinuteStatus };

/** Counted for somebody: for the company, or on the person's own private project. */
export const worked = (v: SortedMinute) => v.verified || v.personal;

export interface Sorting {
  projects: (typeof schema.projects.$inferSelect)[];
  rules: Map<string, Rule[]>;
  assignments: Map<string, Assignment[]>;
}

/** Projects, rules and corrections that apply to these people: the company's and their own. */
export async function loadSorting(orgId: string, memberIds: string[], fromM: number, toM: number): Promise<Sorting> {
  const projects = await db.select().from(schema.projects).where(eq(schema.projects.orgId, orgId));
  const ids = projects.map((p) => p.id);
  const [ruleRows, assignmentRows] = await Promise.all([
    ids.length ? db.select().from(schema.rules).where(inArray(schema.rules.projectId, ids)) : [],
    memberIds.length
      ? db
          .select()
          .from(schema.assignments)
          .where(and(inArray(schema.assignments.memberId, memberIds), lt(schema.assignments.fromM, toM), gte(schema.assignments.toM, fromM - LOOKBACK)))
          .orderBy(asc(schema.assignments.createdAt))
      : [],
  ]);
  const owner = new Map(projects.map((p) => [p.id, p.ownerMemberId]));
  const rules = new Map<string, Rule[]>();
  const assignments = new Map<string, Assignment[]>();
  for (const id of memberIds) {
    // A person's own rules are tried before the company's when both would match.
    const mine = ruleRows.filter((r) => owner.get(r.projectId) === id);
    const shared = ruleRows.filter((r) => owner.get(r.projectId) === null);
    rules.set(id, [...mine, ...shared].map((r) => ({ projectId: r.projectId, field: r.field as RuleField, match: r.match, app: r.app })));
    assignments.set(
      id,
      assignmentRows
        .filter((a) => a.memberId === id && (a.projectId === null || owner.get(a.projectId) === null || owner.get(a.projectId) === id))
        .map((a) => ({ fromM: a.fromM, toM: a.toM, projectId: a.projectId })),
    );
  }
  return { projects, rules, assignments };
}

/**
 * Counted and sorted minutes for people in [fromM, toM). Looks back a little so grace and
 * carry-over work across the edge.
 *
 * Time on a person's own private project is never the company's: it is marked personal and not
 * counted. With `reveal` (the person looking at their own time) it keeps its project and context;
 * without it, all the company sees is that personal time happened.
 */
export async function verifiedInRange(orgId: string, memberIds: string[], fromM: number, toM: number, reveal = false) {
  const out = new Map<string, SortedMinute[]>(memberIds.map((id) => [id, []]));
  if (memberIds.length === 0) return out;
  const range = <T extends { memberId: unknown; m: unknown }>(t: T) =>
    and(inArray(t.memberId as never, memberIds), gte(t.m as never, fromM - LOOKBACK), lt(t.m as never, toM));
  const [inputRows, claudeRows, commitRows, sorting] = await Promise.all([
    db.select().from(schema.minutes).where(range(schema.minutes)),
    db.select().from(schema.claudeUsage).where(range(schema.claudeUsage)),
    db.select().from(schema.commits).where(range(schema.commits)),
    loadSorting(orgId, memberIds, fromM, toM),
  ]);
  const privateIds = new Set(sorting.projects.filter((p) => p.ownerMemberId).map((p) => p.id));
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
    push(r.memberId, {
      ...blank(r.m), keys: r.keys, clicks: r.clicks, moves: r.moves, app: r.app, domain: r.domain, paused: r.paused,
      title: r.title, path: r.path, repo: r.repo, call: r.call,
    });
  }
  for (const c of claudeRows) {
    push(c.memberId, { ...blank(c.m), claudePrompts: c.prompts, tokens: c.tokens, claudeActive: true, claudeProjects: [c.project], paused: paused.has(`${c.memberId}:${c.m}`) });
  }
  for (const c of commitRows) {
    push(c.memberId, { ...blank(c.m), commits: 1, commitRepos: [c.repo], paused: paused.has(`${c.memberId}:${c.m}`) });
  }
  for (const [memberId, list] of raw) {
    const sorted = attributeMinutes(verifyMinutes(list), sorting.rules.get(memberId) ?? [], sorting.assignments.get(memberId) ?? []);
    out.set(
      memberId,
      sorted
        .filter((v) => v.m >= fromM)
        .map((v): SortedMinute => {
          const personal = v.verified && !!v.projectId && privateIds.has(v.projectId);
          if (!personal) return { ...v, background: v.background.filter((p) => reveal || !privateIds.has(p)), personal: false, was: v.status };
          const base = { ...v, status: "personal" as const, verified: false, personal: true, was: v.status };
          if (reveal) return base;
          return {
            ...base, projectId: null, background: [], app: null, domain: null, title: null, path: null, repo: null,
            claudeProjects: [], commitRepos: [], keys: 0, clicks: 0, moves: 0, claudePrompts: 0, tokens: 0, commits: 0,
          };
        }),
    );
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
  minutes: SortedMinute[];
  hours: HourSummary[];
  totals: Totals;
  apps: Usage[];
  sites: Usage[];
  claude: { project: string; prompts: number; tokens: number; sessions: number }[];
  commits: (typeof schema.commits.$inferSelect)[];
  adjustments: (typeof schema.adjustments.$inferSelect)[];
}

function usage(minutes: SortedMinute[], key: (v: SortedMinute) => string | null | undefined): Usage[] {
  const map = new Map<string, number>();
  for (const v of minutes) {
    if (!v.verified) continue;
    const k = key(v);
    if (k) map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].map(([name, minutes]) => ({ name, minutes })).sort((a, b) => b.minutes - a.minutes);
}

/** The app with what it was open on: "T3 Code · tigra", "Slack · #general (Acme)". */
function appDetail(v: SortedMinute): string | null {
  if (!v.app) return null;
  if (v.domain) return v.app;
  if (v.repo) return `${v.app} · ${v.repo}`;
  const key = contextKey(v);
  return key?.field === "title" ? key.label : v.app;
}

/** The site with the first part of the page address: "github.com/acme/api". */
function siteDetail(v: SortedMinute): string | null {
  if (!v.domain) return null;
  const parts = (v.path ?? "").split("/").filter(Boolean).slice(0, 2);
  return [v.domain, ...parts].join("/");
}

export async function dayReport(member: Member, org: Org, day: string, reveal = false): Promise<DayReport> {
  const [fromM, toM] = minuteRangeOfDay(day, org.timezone);
  const minutes = (await verifiedInRange(org.id, [member.id], fromM, toM, reveal)).get(member.id) ?? [];
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
    apps: usage(minutes, appDetail),
    sites: usage(minutes, siteDetail),
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
  const verified = await verifiedInRange(org.id, ids, fromM, toM);
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
  /** Project they are on right now, if their time is sorted. */
  projectId: string | null;
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
  const verified = await verifiedInRange(org.id, ids, fromM, toM);
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
      projectId: recent?.projectId ?? null,
      today: totals(minutes),
      hourly,
    };
  });
}
