import Link from "next/link";
import { Refresher } from "@/components/refresher";
import { requireOwner } from "@/lib/auth";
import { ago, hm } from "@/lib/format";
import { teamReport, type TeamRow } from "@/lib/report";
import { getScope, scopeProjects } from "@/lib/scope";

const states: Record<TeamRow["state"], { text: string; dot: string }> = {
  working: { text: "Working now", dot: "var(--active)" },
  idle: { text: "At computer, idle", dot: "var(--idle)" },
  paused: { text: "Paused", dot: "var(--paused)" },
  offline: { text: "Tracker offline", dot: "var(--weak)" },
  never: { text: "Not set up yet", dot: "var(--border)" },
};

function Spark({ hourly }: { hourly: number[] }) {
  return (
    <svg viewBox="0 0 96 20" className="h-5 w-24" role="img" aria-label="Counted minutes for each hour of today">
      {hourly.map((v, i) => (
        <rect key={i} x={i * 4} y={20 - Math.max(1, (v / 60) * 20)} width={3} height={Math.max(1, (v / 60) * 20)} fill={v ? "var(--active)" : "var(--idle)"} />
      ))}
    </svg>
  );
}

export default async function TeamPage() {
  const { org } = await requireOwner();
  const rows = await teamReport(org);
  const projectName = new Map((await scopeProjects(await getScope())).map((p) => [p.id, p.name]));
  const working = rows.filter((r) => r.state === "working").length;
  const total = rows.reduce((n, r) => n + r.today.verifiedMinutes, 0);
  return (
    <div className="space-y-5">
      <Refresher />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
          <p className="text-sm text-muted">
            {rows.length === 0
              ? "Nobody on the team yet."
              : `${working} of ${rows.length} working now · ${hm(total)} counted today`}
          </p>
        </div>
        <Link className="btn-quiet" href="/settings">Add someone</Link>
      </div>

      {rows.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="font-medium">Add your first person</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            You get an invite link to send them. They install the app, paste the code, and their hours start
            showing up here by themselves.
          </p>
          <Link className="btn mt-4" href="/settings">Add someone</Link>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-border">
                <th className="th">Person</th>
                <th className="th">Right now</th>
                <th className="th">Today by hour</th>
                <th className="th text-right">Counted today</th>
                <th className="th text-right">Claude prompts</th>
                <th className="th text-right">Commits</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.member.id} className="border-b border-border last:border-0">
                  <td className="td font-medium">
                    <Link href={`/people/${r.member.id}`} className="hover:text-accent">{r.member.name}</Link>
                  </td>
                  <td className="td">
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: states[r.state].dot }} />
                      <span>
                        {states[r.state].text}
                        <span className="block text-xs text-muted">
                          {r.state === "working" || r.state === "idle"
                            ? [r.projectId && projectName.get(r.projectId), r.app, r.domain].filter(Boolean).join(" · ") || " "
                            : r.state === "offline"
                              ? `Last seen ${ago(r.lastSeenAt)}`
                              : " "}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td className="td"><Spark hourly={r.hourly} /></td>
                  <td className="td num text-right font-medium">
                    {hm(r.today.verifiedMinutes)}
                    {r.today.weakMinutes > 0 && <span className="block text-xs font-normal text-weak">{hm(r.today.weakMinutes)} thin evidence</span>}
                  </td>
                  <td className="td num text-right">{r.today.claudePrompts}</td>
                  <td className="td num text-right">{r.today.commits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
