import { addDays, contextKey, dayOfMinute } from "@openstaff/core";
import { deviceFromRequest } from "@/lib/auth";
import { projectReport, rangeFor } from "@/lib/projects";
import { worked } from "@/lib/report";
import type { Scope } from "@/lib/scope";

/**
 * For the optional "sort with Claude" on the person's own computer: their unsorted time of the
 * last week as labels, the projects it could go to, and what today looked like.
 */
export async function GET(req: Request) {
  const auth = await deviceFromRequest(req);
  if (!auth) return Response.json({ error: "Unknown device" }, { status: 401 });
  const scope: Scope = { kind: "personal", org: auth.org, ownerMemberId: auth.member.id, members: [auth.member], base: "/me", sender: auth.member.name };
  const today = dayOfMinute(Math.floor(Date.now() / 60_000), auth.org.timezone);
  const report = await projectReport(scope, rangeFor(scope, addDays(today, -6), today));
  const day = new Map<string, number>();
  for (const v of report.minutes.get(auth.member.id) ?? []) {
    if (!worked(v) || dayOfMinute(v.m, auth.org.timezone) !== today) continue;
    const label = contextKey(v)?.label;
    if (label) day.set(label, (day.get(label) ?? 0) + 1);
  }
  return Response.json({
    day: today,
    projects: report.rows.map((p) => ({ id: p.id, name: p.name })),
    unsorted: report.unsorted.slice(0, 60).map((g) => ({ field: g.field, match: g.match, label: g.label, minutes: g.minutes })),
    today: [...day.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([label, minutes]) => ({ label, minutes })),
  });
}
