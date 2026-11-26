import { addDays, contextKey, dayOfMinute } from "@openstaff/core";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getScope, scopeProjects } from "@/lib/scope";
import { AssignSelect } from "./assign-select";
import Link from "next/link";
import { addAdjustment, assignTime, deleteAdjustment } from "@/app/actions";
import type { Member, Org } from "@/lib/auth";
import { clock, compact, hm, longDay } from "@/lib/format";
import { dayReport, worked, type SortedMinute, type Usage } from "@/lib/report";
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
          {rows.slice(0, 12).map((r) => (
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

interface Block {
  fromM: number;
  toM: number;
  projectId: string | null;
  personal: boolean;
  minutes: number;
  labels: Map<string, number>;
}

/** Stretches of worked time on one project, bridging pauses of a few minutes. */
function blocks(minutes: SortedMinute[]): Block[] {
  const out: Block[] = [];
  for (const v of minutes) {
    if (!worked(v)) continue;
    const last = out[out.length - 1];
    const same = last && last.projectId === v.projectId && last.personal === v.personal && v.m - last.toM <= 5;
    const b = same ? last : { fromM: v.m, toM: v.m, projectId: v.projectId, personal: v.personal, minutes: 0, labels: new Map<string, number>() };
    if (!same) out.push(b);
    b.toM = v.m + 1;
    b.minutes++;
    const label = contextKey(v)?.label;
    if (label) b.labels.set(label, (b.labels.get(label) ?? 0) + 1);
  }
  return out;
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
  const scope = await getScope();
  const reveal = scope.kind === "personal";
  const [r, mine, all, summary] = await Promise.all([
    dayReport(member, org, shown, reveal),
    scopeProjects(scope),
    db.select().from(schema.projects).where(eq(schema.projects.orgId, org.id)),
    db.query.daySummaries.findFirst({ where: (t, { and, eq }) => and(eq(t.memberId, member.id), eq(t.day, shown)) }),
  ]);
  const known = new Map(all.filter((p) => p.ownerMemberId === null || (reveal && p.ownerMemberId === member.id)).map((p) => [p.id, p]));
  const colors = new Map([...known.values()].map((p) => [p.id, p.color]));
  const list = blocks(r.minutes);
  const perProject = new Map<string, number>();
  for (const b of list) {
    const key = b.personal && !reveal ? "personal" : b.projectId && known.has(b.projectId) ? b.projectId : "unsorted";
    perProject.set(key, (perProject.get(key) ?? 0) + b.minutes);
  }
  const projectRows = [...perProject.entries()].sort((a, b) => b[1] - a[1]);
  const maxProject = Math.max(1, ...projectRows.map(([, n]) => n));
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
          hint={[
            adjusted ? `${hm(r.totals.verifiedMinutes)} tracked, ${hm(adjusted)} added by hand` : null,
            r.totals.meetingMinutes ? `${hm(r.totals.meetingMinutes)} on calls` : null,
            r.totals.personalMinutes ? `${hm(r.totals.personalMinutes)} on own projects not counted` : null,
            !adjusted && !r.totals.meetingMinutes && !r.totals.personalMinutes && idleShare ? `${hm(r.totals.idleMinutes)} idle left out` : null,
          ].filter(Boolean).join(" · ") || undefined}
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
          <Timeline minutes={r.minutes} hours={r.hours} fromM={r.fromM} toM={r.toM} colors={colors} />
        )}
        {r.totals.weakMinutes > 0 && (
          <p className="mt-3 text-sm text-weak">
            {hm(r.totals.weakMinutes)} of counted time had mouse movement only, with no typing, clicks, Claude
            or commits. Worth a conversation before it is paid.
          </p>
        )}
      </section>

      {summary && (
        <section className="card p-5">
          <h2 className="text-sm font-medium">Summary of the day</h2>
          <p className="mt-2 whitespace-pre-line text-sm text-muted">{summary.text}</p>
          <p className="mt-2 text-xs text-muted">Written by Claude on {member.name}&apos;s own computer from the list of what was open.</p>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="text-sm font-medium">By project</h2>
          {projectRows.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No time worked on this day.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {projectRows.map(([key, n]) => {
                const p = known.get(key);
                return (
                  <li key={key} className="text-sm">
                    <div className="flex justify-between gap-3">
                      <span className="truncate">{p?.name ?? (key === "personal" ? "Own projects (private)" : "Unsorted")}</span>
                      <span className="num shrink-0 text-muted">{hm(n)}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-bg">
                      <div className="h-1.5 rounded-full" style={{ width: `${(n * 100) / maxProject}%`, background: p?.color ?? (key === "personal" ? "var(--personal)" : "var(--idle)") }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="card p-5">
          <h2 className="text-sm font-medium">What happened, in order</h2>
          {list.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No time worked on this day.</p>
          ) : (
            <ul className="mt-2 max-h-80 divide-y divide-border overflow-y-auto">
              {list.map((b) => {
                const shared = !!b.projectId && !mine.some((p) => p.id === b.projectId) && known.has(b.projectId);
                return (
                  <li key={b.fromM} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="num">{clock(b.fromM, org.timezone)} to {clock(b.toM, org.timezone)} · <span className="font-medium">{hm(b.minutes)}</span></p>
                      <p className="truncate text-xs text-muted">
                        {b.personal && !reveal
                          ? "On their own project. Details are private."
                          : [...b.labels.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([l]) => l).join(", ") || "No detail recorded"}
                      </p>
                    </div>
                    {b.personal && !reveal ? null : shared && reveal ? (
                      <span className="text-xs text-muted">{known.get(b.projectId!)?.name}</span>
                    ) : (
                      <AssignSelect
                        action={assignTime}
                        hidden={{ memberId: member.id, fromM: b.fromM, toM: b.toM }}
                        projects={mine.map((p) => ({ id: p.id, name: p.name }))}
                        value={b.projectId && mine.some((p) => p.id === b.projectId) ? b.projectId : ""}
                        label={`Project for ${clock(b.fromM, org.timezone)}`}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Bars title="Apps and what they were open on" rows={r.apps} empty="No app activity recorded." />
        <Bars title="Websites and pages" rows={r.sites} empty="No browser activity recorded." />
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
