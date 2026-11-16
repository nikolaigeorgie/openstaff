import { addDays, dayOfMinute } from "@openstaff/core";
import Link from "next/link";
import { addAdjustment, deleteAdjustment } from "@/app/actions";
import type { Member, Org } from "@/lib/auth";
import { clock, compact, hm, longDay } from "@/lib/format";
import { dayReport, type Usage } from "@/lib/report";
import { Legend, Timeline } from "./timeline";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="num mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Bars({ title, rows, empty }: { title: string; rows: Usage[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.minutes));
  return (
    <section className="card p-5">
      <h2 className="text-sm font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.slice(0, 8).map((r) => (
            <li key={r.name} className="text-sm">
              <div className="flex justify-between gap-3">
                <span className="truncate">{r.name}</span>
                <span className="num shrink-0 text-muted">{hm(r.minutes)}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-bg">
                <div className="h-1.5 rounded-full bg-active" style={{ width: `${(r.minutes * 100) / max}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One person's day. Owners and the person themselves see the same thing. */
export async function PersonDay({
  member,
  org,
  day,
  basePath,
  owner,
}: {
  member: Member;
  org: Org;
  day?: string;
  basePath: string;
  owner: boolean;
}) {
  const today = dayOfMinute(Math.floor(Date.now() / 60_000), org.timezone);
  const shown = day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today ? day : today;
  const r = await dayReport(member, org, shown);
  const adjusted = r.adjustments.reduce((n, a) => n + a.minutes, 0);
  const idleShare = r.totals.verifiedMinutes + r.totals.idleMinutes;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{member.name}</h1>
          <p className="text-sm text-muted">{longDay(shown)}{shown === today ? " · today" : ""}</p>
        </div>
        <div className="flex gap-2">
          <Link className="btn-quiet" href={`${basePath}?day=${addDays(shown, -1)}`}>← Previous day</Link>
          {shown < today && <Link className="btn-quiet" href={`${basePath}?day=${addDays(shown, 1)}`}>Next day →</Link>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Counted time"
          value={hm(r.totals.verifiedMinutes + adjusted)}
          hint={adjusted ? `${hm(r.totals.verifiedMinutes)} tracked, ${hm(adjusted)} added by hand` : idleShare ? `${hm(r.totals.idleMinutes)} idle left out` : undefined}
        />
        <Stat label="Claude prompts" value={String(r.totals.claudePrompts)} hint={`${compact(r.totals.tokens)} tokens`} />
        <Stat label="Commits" value={String(r.totals.commits)} hint={r.commits.length ? `+${r.commits.reduce((n, c) => n + c.added, 0)} / -${r.commits.reduce((n, c) => n + c.removed, 0)} lines` : undefined} />
        <Stat label="Keys and clicks" value={compact(r.totals.keys + r.totals.clicks)} hint="Counts only, never what was typed" />
      </div>

      <section className="card p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Timeline</h2>
          <Legend />
        </div>
        {r.minutes.length === 0 ? (
          <p className="py-6 text-sm text-muted">Nothing recorded on this day.</p>
        ) : (
          <Timeline minutes={r.minutes} hours={r.hours} fromM={r.fromM} toM={r.toM} />
        )}
        {r.totals.weakMinutes > 0 && (
          <p className="mt-3 text-sm text-weak">
            {hm(r.totals.weakMinutes)} of counted time had mouse movement only, with no typing, clicks, Claude
            or commits. Worth a conversation before it is paid.
          </p>
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Bars title="Apps" rows={r.apps} empty="No app activity recorded." />
        <Bars title="Websites" rows={r.sites} empty="No browser activity recorded." />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="text-sm font-medium">Claude Code by project</h2>
          {r.claude.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No Claude Code sessions on this day.</p>
          ) : (
            <table className="mt-2 w-full">
              <thead>
                <tr><th className="th pl-0">Project</th><th className="th text-right">Prompts</th><th className="th text-right">Sessions</th><th className="th pr-0 text-right">Tokens</th></tr>
              </thead>
              <tbody>
                {r.claude.map((c) => (
                  <tr key={c.project} className="border-t border-border">
                    <td className="td pl-0">{c.project}</td>
                    <td className="td num text-right">{c.prompts}</td>
                    <td className="td num text-right">{c.sessions}</td>
                    <td className="td num pr-0 text-right">{compact(c.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="card p-5">
          <h2 className="text-sm font-medium">Commits</h2>
          {r.commits.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No commits on this day.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {r.commits.map((c) => (
                <li key={c.sha} className="py-2 text-sm">
                  <p className="truncate">{c.subject || "(no message)"}</p>
                  <p className="num text-xs text-muted">
                    {clock(c.m, org.timezone)} · {c.repo} · <span className="font-mono">{c.sha.slice(0, 7)}</span> · +{c.added} / -{c.removed}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {(owner || r.adjustments.length > 0) && (
        <section className="card p-5">
          <h2 className="text-sm font-medium">Time added by hand</h2>
          <p className="mt-1 text-sm text-muted">For work away from the computer, like calls and meetings.</p>
          {r.adjustments.length > 0 && (
            <ul className="mt-3 divide-y divide-border">
              {r.adjustments.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span><span className="num font-medium">{hm(a.minutes)}</span> · {a.note}</span>
                  {owner && (
                    <form action={deleteAdjustment}>
                      <input type="hidden" name="id" value={a.id} />
                      <button className="text-xs text-muted underline">Remove</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {owner && (
            <form action={addAdjustment} className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="memberId" value={member.id} />
              <input type="hidden" name="day" value={shown} />
              <div className="w-24">
                <label className="label" htmlFor="hours">Hours</label>
                <input className="input" id="hours" name="hours" type="number" step="0.25" min="-24" max="24" required placeholder="1.5" />
              </div>
              <div className="min-w-48 flex-1">
                <label className="label" htmlFor="note">Reason</label>
                <input className="input" id="note" name="note" required maxLength={200} placeholder="Client call" />
              </div>
              <button className="btn-quiet">Add time</button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
