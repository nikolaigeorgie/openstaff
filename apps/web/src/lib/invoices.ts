import { addDays, dayOfMinute, minuteRangeOfDay } from "@openstaff/core";
import type { InvoiceLine } from "@/db/schema";
import { verifiedInRange, worked } from "./report";
import { scopeInvoices, scopeProjects, type Scope } from "./scope";

/**
 * Lines for a new invoice: one per project of the client, with the time worked on it between the
 * two days. Days already covered by another invoice for that project are left out, so the same
 * time cannot be billed twice.
 */
export async function draftLines(scope: Scope, clientId: string, fromDay: string, toDay: string) {
  const projects = (await scopeProjects(scope)).filter((p) => p.clientId === clientId);
  const existing = await scopeInvoices(scope);
  const tz = scope.org.timezone;
  const fromM = minuteRangeOfDay(fromDay, tz)[0];
  const toM = minuteRangeOfDay(toDay, tz)[1];
  const minutes = await verifiedInRange(scope.org.id, scope.members.map((m) => m.id), fromM, toM, scope.kind === "personal");
  const perDay = new Map<string, Map<string, number>>(projects.map((p) => [p.id, new Map()]));
  for (const list of minutes.values()) {
    for (const v of list) {
      if (!worked(v) || !v.projectId) continue;
      const days = perDay.get(v.projectId);
      if (!days) continue;
      const day = dayOfMinute(v.m, tz);
      days.set(day, (days.get(day) ?? 0) + 1);
    }
  }
  let skippedMinutes = 0;
  const lines: InvoiceLine[] = [];
  for (const p of projects) {
    const days = perDay.get(p.id)!;
    let total = 0;
    for (const [day, n] of days) {
      const billed = existing.some((inv) => day >= inv.fromDay && day <= inv.toDay && inv.lines.some((l) => l.projectId === p.id));
      if (billed) skippedMinutes += n;
      else total += n;
    }
    if (total > 0) lines.push({ projectId: p.id, description: p.name, minutes: total, rateCents: p.rateCents, amountCents: amount(total, p.rateCents) });
  }
  return { lines, skippedMinutes };
}

export const amount = (minutes: number, rateCents: number) => Math.round((minutes / 60) * rateCents);

export function lastMonth(today: string): [string, string] {
  const first = today.slice(0, 8) + "01";
  const end = addDays(first, -1);
  return [end.slice(0, 8) + "01", end];
}
