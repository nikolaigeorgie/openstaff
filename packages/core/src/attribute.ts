import type { MinuteRecord, VerifiedMinute } from "./types";

/**
 * Sorting time into projects.
 *
 * A project is a set of rules over what was in front during a minute. Rules are applied to raw
 * minutes each time a report is built, so adding or fixing a rule re-sorts past time as well.
 */
export type RuleField = "repo" | "url" | "title" | "site" | "app";

export interface Rule {
  projectId: string;
  field: RuleField;
  /** Text to look for. repo, site and app must be equal; url is a prefix; title is contained. */
  match: string;
  /** Only when this app is in front (used by title rules, e.g. a Slack channel). */
  app?: string | null;
}

/** A correction made by hand for a stretch of one person's time. `toM` is exclusive. */
export interface Assignment {
  fromM: number;
  toM: number;
  projectId: string | null;
}

export interface AttributedMinute extends VerifiedMinute {
  projectId: string | null;
  via: "manual" | "rule" | "carry" | null;
  /** Other projects Claude was working on in this minute. Shown, never billed twice. */
  background: string[];
}

const ORDER: RuleField[] = ["repo", "url", "title", "site", "app"];
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function matches(rule: Rule, r: MinuteRecord): boolean {
  const want = norm(rule.match);
  if (!want) return false;
  if (rule.app && norm(rule.app) !== norm(r.app)) return false;
  switch (rule.field) {
    case "repo":
      return norm(r.repo) === want;
    case "url": {
      if (!r.domain) return false;
      const url = norm(r.domain) + (r.path ? norm(r.path) : "/");
      return url === want || url.startsWith(want.endsWith("/") ? want : want + "/") || url.startsWith(want + "?");
    }
    case "title":
      return norm(r.title).includes(want);
    case "site": {
      const d = norm(r.domain);
      return d === want || d.endsWith("." + want);
    }
    case "app":
      return norm(r.app) === want;
  }
}

/** Rules in the order they are tried: most specific kind first, then the longest text. */
export function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort(
    (a, b) => ORDER.indexOf(a.field) - ORDER.indexOf(b.field) || b.match.length - a.match.length,
  );
}

function repoProject(sorted: Rule[], repo: string): string | null {
  const want = norm(repo);
  return sorted.find((r) => r.field === "repo" && norm(r.match) === want)?.projectId ?? null;
}

export function attributeMinutes(
  minutes: VerifiedMinute[],
  rules: Rule[],
  assignments: Assignment[] = [],
  opts: { carryMinutes: number } = { carryMinutes: 10 },
): AttributedMinute[] {
  const sorted = sortRules(rules);
  // Later corrections win over earlier ones.
  const manual = [...assignments].reverse();
  const out: AttributedMinute[] = minutes.map((v) => {
    const claude = (v.claudeProjects ?? []).map((p) => repoProject(sorted, p)).filter((p): p is string => !!p);
    let projectId: string | null = null;
    let via: AttributedMinute["via"] = null;
    const fixed = manual.find((a) => v.m >= a.fromM && v.m < a.toM);
    if (fixed) {
      projectId = fixed.projectId;
      via = "manual";
    } else {
      projectId = sorted.find((rule) => matches(rule, v))?.projectId ?? null;
      // Nothing in front decides it: go by what Claude was doing for them, then by a commit.
      if (!projectId) projectId = claude[0] ?? null;
      if (!projectId) {
        for (const repo of v.commitRepos ?? []) projectId ??= repoProject(sorted, repo);
      }
      if (projectId) via = "rule";
    }
    return { ...v, projectId, via, background: [...new Set(claude)].filter((p) => p !== projectId) };
  });

  // A short detour between two stretches of the same project belongs to that project.
  let prev: AttributedMinute | null = null;
  let gap: AttributedMinute[] = [];
  for (const v of out) {
    if (!v.verified) continue;
    if (v.via === null) {
      gap.push(v);
      continue;
    }
    if (
      prev && gap.length > 0 && gap.length <= opts.carryMinutes &&
      prev.projectId && prev.projectId === v.projectId && v.m - prev.m <= opts.carryMinutes * 3
    ) {
      for (const g of gap) {
        g.projectId = v.projectId;
        g.via = "carry";
        g.background = g.background.filter((p) => p !== v.projectId);
      }
    }
    prev = v;
    gap = [];
  }
  return out;
}

export interface ContextKey {
  /** The rule that would catch this kind of time. */
  field: RuleField;
  match: string;
  app: string | null;
  /** How to show it to a person, e.g. "Slack · #general". */
  label: string;
}

const SEPARATORS = [" — ", " – ", " - ", " | "];

function titleParts(title: string): string[] {
  let parts = [title];
  for (const sep of SEPARATORS) parts = parts.flatMap((p) => p.split(sep));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * What a minute was about, as the single most telling thing we know: the repo, else the site,
 * else the window (a Slack channel, a document, a call), else just the app.
 */
export function contextKey(r: MinuteRecord): ContextKey | null {
  const app = r.app?.trim() || null;
  if (r.repo) return { field: "repo", match: r.repo, app: null, label: r.repo };
  if (r.domain) return { field: "site", match: r.domain, app: null, label: r.domain };
  if (app && r.title) {
    const parts = titleParts(r.title).filter((p) => norm(p) !== norm(app));
    if (norm(app) === "slack" && parts.length > 0) {
      const channel = parts[0].replace(/^[*!•\s]+/, "").replace(/\s*\((channel|dm|private channel|thread)\)$/i, "");
      const workspace = parts.length > 1 ? parts[parts.length - 1] : null;
      const shown = /^[#@]/.test(channel) || / /.test(channel) ? channel : `#${channel}`;
      return { field: "title", match: parts[0], app, label: `Slack · ${shown}${workspace ? ` (${workspace})` : ""}` };
    }
    // Editors and most document apps put the workspace or document last.
    const subject = parts[parts.length - 1];
    if (subject && subject.length <= 80) return { field: "title", match: subject, app, label: `${app} · ${subject}` };
  }
  if (app) return { field: "app", match: app, app: null, label: app };
  const claude = r.claudeProjects?.[0];
  if (claude) return { field: "repo", match: claude, app: null, label: claude };
  return null;
}
