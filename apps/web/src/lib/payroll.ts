import { dayOfMinute, periodAt, periodFor, type Period } from "@openstaff/core";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Org } from "./auth";
import { periodReport, type PeriodRow } from "./report";

export interface Payroll {
  period: Period;
  currentIndex: number;
  rows: PeriodRow[];
  lockedAt: Date | null;
}

/** A pay period's numbers: the approved snapshot if it was locked, otherwise live. */
export async function payroll(org: Org, requested?: string): Promise<Payroll> {
  const today = dayOfMinute(Math.floor(Date.now() / 60_000), org.timezone);
  const current = periodFor(today, org.periodAnchor, org.periodDays);
  const n = Number(requested);
  const index = requested !== undefined && Number.isInteger(n) && n <= current.index ? n : current.index;
  const period = periodAt(index, org.periodAnchor, org.periodDays);
  const [lock] = await db
    .select()
    .from(schema.periodLocks)
    .where(and(eq(schema.periodLocks.orgId, org.id), eq(schema.periodLocks.periodIndex, index)))
    .limit(1);
  return {
    period,
    currentIndex: current.index,
    rows: lock ? (lock.snapshot as PeriodRow[]) : await periodReport(org, period),
    lockedAt: lock?.lockedAt ?? null,
  };
}
