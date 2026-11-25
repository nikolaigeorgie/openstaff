import { contextKey, dayOfMinute, minuteRangeOfDay, periodFor, type ContextKey, type RuleField } from "@openstaff/core";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { db, schema } from "@/db";
import { verifiedInRange, worked, type SortedMinute } from "./report";
import { scopeProjects, type Scope } from "./scope";

export interface Range {
  from: string;
  to: string;
  fromM: number;
  toM: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The dates asked for, or the current pay period. Never beyond a year, never backwards. */
export function rangeFor(scope: Scope, from?: string, to?: string): Range {
  const tz = scope.org.timezone;
  const today = dayOfMinute(Math.floor(Date.now() / 60_000), tz);
  const period = periodFor(today, scope.org.periodAnchor, scope.org.periodDays);
  let a = from && DAY.test(from) ? from : period.start;
  let b = to && DAY.test(to) ? to : from && DAY.test(from) ? today : period.end;
  if (b < a) [a, b] = [b, a];
  let fromM = minuteRangeOfDay(a, tz)[0];
  const toM = minuteRangeOfDay(b, tz)[1];
  if (toM - fromM > 366 * 1440) fromM = toM - 366 * 1440;
  return { from: a, to: b, fromM, toM };
}

export interface ProjectRow {
  id: string;
  name: string;
  color: string;
  clientId: string | null;
  rateCents: number;
  /** A company project seen from a person's own pages: shown, not theirs to change. */
  shared: boolean;
  minutes: number;
  /** Counted minutes by how they were backed up. */
  active: number;
  grace: number;
  claude: number;
  meeting: number;
  /** Minutes Claude worked on this project while the person was on another one. Not billed. */
  background: number;
  byMember: Map<string, number>;
  byDay: Map<string, number>;
  keys: number;
  prompts: number;
  tokens: number;
  commits: number;
  added: number;
  removed: number;
}

export interface UnsortedGroup extends ContextKey {
  minutes: number;
  members: Set<string>;
  suggestedProjectId: string | null;
}

export interface ProjectReport {
  range: Range;
  rows: ProjectRow[];
  unsorted: UnsortedGroup[];
  unsortedMinutes: number;
  totalMinutes: number;
  /** Time on people's own private projects, which the company cannot see into. */
  personalMinutes: number;
  minutes: Map<string, SortedMinute[]>;
}

export const groupKey = (k: { field: string; match: string; app?: string | null }) =>
  `${k.field}\u0000${k.match.toLowerCase()}\u0000${(k.app ?? "").toLowerCase()}`;

export async function projectReport(scope: Scope, range: Range): Promise<ProjectReport> {
  const ids = scope.members.map((m) => m.id);
  const reveal = scope.kind === "personal";
  const [minutes, mine, all, ruleRows, claudeRows, commitRows, suggestionRows] = await Promise.all([
    verifiedInRange(scope.org.id, ids, range.fromM, range.toM, reveal),
    scopeProjects(scope),
    db.select().from(schema.projects).where(eq(schema.projects.orgId, scope.org.id)),
    db
      .select({ rule: schema.rules, ownerMemberId: schema.projects.ownerMemberId })
      .from(schema.rules)
      .innerJoin(schema.projects, eq(schema.rules.projectId, schema.projects.id))
      .where(eq(schema.projects.orgId, scope.org.id)),
    ids.length
      ? db.select().from(schema.claudeUsage).where(and(inArray(schema.claudeUsage.memberId, ids), gte(schema.claudeUsage.m, range.fromM), lt(schema.claudeUsage.m, range.toM)))
      : [],
    ids.length
      ? db.select().from(schema.commits).where(and(inArray(schema.commits.memberId, ids), gte(schema.commits.m, range.fromM), lt(schema.commits.m, range.toM)))
      : [],
    ids.length ? db.select().from(schema.suggestions).where(inArray(schema.suggestions.memberId, ids)) : [],
  ]);
  // Projects this view may name: its own, plus the company's when a person looks at their time.
  const visible = all.filter((p) => (scope.kind === "company" ? p.ownerMemberId === null : p.ownerMemberId === null || p.ownerMemberId === scope.ownerMemberId));
  const mineIds = new Set(mine.map((p) => p.id));
  const rows = new Map<string, ProjectRow>(
    visible.map((p) => [
      p.id,
      {
        id: p.id, name: p.name, color: p.color, clientId: p.clientId, rateCents: p.rateCents, shared: !mineIds.has(p.id),
        minutes: 0, active: 0, grace: 0, claude: 0, meeting: 0, background: 0,
        byMember: new Map(), byDay: new Map(), keys: 0, prompts: 0, tokens: 0, commits: 0, added: 0, removed: 0,
      },
    ]),
  );
  const unsorted = new Map<string, UnsortedGroup>();
  let unsortedMinutes = 0;
  let totalMinutes = 0;
  let personalMinutes = 0;
  const tz = scope.org.timezone;
  for (const [memberId, list] of minutes) {
    for (const v of list) {
      for (const b of v.background) {
        const row = rows.get(b);
        if (row) row.background++;
      }
      if (!worked(v)) continue;
      if (v.personal && !reveal) {
        personalMinutes++;
        continue;
      }
      totalMinutes++;
      const row = v.projectId ? rows.get(v.projectId) : undefined;
      if (row) {
        row.minutes++;
        row[v.was === "active" || v.was === "grace" || v.was === "claude" || v.was === "meeting" ? v.was : "grace"]++;
        row.keys += v.keys + v.clicks;
        row.byMember.set(memberId, (row.byMember.get(memberId) ?? 0) + 1);
        const day = dayOfMinute(v.m, tz);
        row.byDay.set(day, (row.byDay.get(day) ?? 0) + 1);
        continue;
      }
      unsortedMinutes++;
      const key = contextKey(v);
      if (!key) continue;
      const k = groupKey(key);
      const g = unsorted.get(k) ?? { ...key, minutes: 0, members: new Set<string>(), suggestedProjectId: null };
      g.minutes++;
      g.members.add(memberId);
      unsorted.set(k, g);
    }
  }
  // Claude usage and commits carry their repo, so they go to a project through its repo rules.
  const repoProject = (memberId: string, repo: string) => {
    const want = repo.toLowerCase();
    const hits = ruleRows.filter((r) => r.rule.field === "repo" && r.rule.match.toLowerCase() === want && (r.ownerMemberId === null || r.ownerMemberId === memberId));
    const hit = hits.find((r) => r.ownerMemberId === memberId) ?? hits[0];
    return hit ? rows.get(hit.rule.projectId) : undefined;
  };
  for (const c of claudeRows) {
    const row = repoProject(c.memberId, c.project);
    if (row) {
      row.prompts += c.prompts;
      row.tokens += c.tokens;
    }
  }
  for (const c of commitRows) {
    const row = repoProject(c.memberId, c.repo);
    if (row) {
      row.commits++;
      row.added += c.added;
      row.removed += c.removed;
    }
  }
  for (const s of suggestionRows) {
    for (const g of unsorted.values()) {
      if (g.field === s.field && g.match.toLowerCase() === s.match.toLowerCase() && mineIds.has(s.projectId) && g.members.has(s.memberId)) g.suggestedProjectId = s.projectId;
    }
  }
  return {
    range,
    rows: [...rows.values()].sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
    unsorted: [...unsorted.values()].sort((a, b) => b.minutes - a.minutes),
    unsortedMinutes,
    totalMinutes,
    personalMinutes,
    minutes,
  };
}

export const FIELD_NAMES: Record<RuleField, string> = {
  repo: "Repository or folder is",
  url: "Page address starts with",
  title: "Window title contains",
  site: "Website is",
  app: "App is",
};
