import { dayOfMinute } from "@openstaff/core";
import type { Member, Org } from "./auth";
import { dayReport } from "./report";

/** What the tray app shows: today's counted time for this person. */
export async function todaySummary(member: Member, org: Org) {
  const nowM = Math.floor(Date.now() / 60_000);
  const day = dayOfMinute(nowM, org.timezone);
  const report = await dayReport(member, org, day);
  return {
    day,
    verifiedMinutes: report.totals.verifiedMinutes,
    claudePrompts: report.totals.claudePrompts,
    commits: report.totals.commits,
    member: member.name,
    org: org.name,
  };
}
