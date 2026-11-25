import Link from "next/link";
import { createProject, sortGroup } from "@/app/actions";
import { compact, hm, longDay, money } from "@/lib/format";
import { projectReport, rangeFor, type ProjectRow } from "@/lib/projects";
import { scopeClients, type Scope } from "@/lib/scope";
import { addDays } from "@openstaff/core";

export function Split({ row }: { row: Pick<ProjectRow, "active" | "grace" | "claude" | "meeting" | "minutes"> }) {
  const parts: [number, string, string][] = [
    [row.active, "var(--active)", "typing or clicking"],
    [row.grace, "var(--grace)", "reading or thinking"],
    [row.claude, "var(--claude)", "waiting on Claude"],
    [row.meeting, "var(--meeting)", "on calls"],
  ];
  if (!row.minutes) return <span className="text-muted">–</span>;
  return (
    <span
      className="flex h-2 w-28 overflow-hidden rounded-full bg-bg"
      title={parts.filter(([n]) => n).map(([n, , t]) => `${hm(n)} ${t}`).join(", ")}
    >
      {parts.map(([n, color, t]) => (n ? <span key={t} style={{ width: `${(n * 100) / row.minutes}%`, background: color }} /> : null))}
    </span>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />;
}

/** Hours by project, and the time that still needs a project. Same page for a company and a person. */
export async function ProjectsView({ scope, from, to }: { scope: Scope; from?: string; to?: string }) {
  const range = rangeFor(scope, from, to);
  const [report, clients] = await Promise.all([projectReport(scope, range), scopeClients(scope)]);
  const mine = report.rows.filter((r) => !r.shared);
  const names = new Map(scope.members.map((m) => [m.id, m.name]));
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const sorted = report.totalMinutes - report.unsortedMinutes;
  const today = rangeFor(scope).to;
  const quick: [string, string][] = [
    ["This pay period", `${scope.base}/projects`],
    ["Last 7 days", `${scope.base}/projects?from=${addDays(today, -6)}&to=${today}`],
    ["Last 30 days", `${scope.base}/projects?from=${addDays(today, -29)}&to=${today}`],
  ];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{scope.kind === "personal" ? "My projects" : "Projects"}</h1>
          <p className="text-sm text-muted">{longDay(range.from)} to {longDay(range.to)}</p>
        </div>
        <form className="flex flex-wrap items-end gap-2" action={`${scope.base}/projects`}>
          <div>
            <label className="label" htmlFor="from">From</label>
            <input className="input" id="from" name="from" type="date" defaultValue={range.from} />
          </div>
          <div>
            <label className="label" htmlFor="to">To</label>
            <input className="input" id="to" name="to" type="date" defaultValue={range.to} />
          </div>
          <button className="btn-quiet">Show</button>
        </form>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        {quick.map(([label, href]) => <Link key={label} className="text-muted underline" href={href}>{label}</Link>)}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs text-muted">Time worked</p>
          <p className="num mt-1 text-2xl font-semibold tracking-tight">{hm(report.totalMinutes)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Sorted into projects</p>
          <p className="num mt-1 text-2xl font-semibold tracking-tight">{hm(sorted)}</p>
          <p className="mt-0.5 text-xs text-muted">{report.totalMinutes ? Math.round((sorted * 100) / report.totalMinutes) : 0}% of the time</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Still unsorted</p>
          <p className="num mt-1 text-2xl font-semibold tracking-tight">{hm(report.unsortedMinutes)}</p>
        </div>
        {scope.kind === "company" && report.personalMinutes > 0 && (
          <div className="card p-4">
            <p className="text-xs text-muted">On people&apos;s own projects</p>
            <p className="num mt-1 text-2xl font-semibold tracking-tight">{hm(report.personalMinutes)}</p>
            <p className="mt-0.5 text-xs text-muted">Not counted for the company</p>
          </div>
        )}
      </div>

      <section className="space-y-3">
        {report.rows.length === 0 ? (
          <p className="card p-6 text-sm text-muted">
            No projects yet. Make one below, or pick a line under Unsorted time and turn it into a project.
          </p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[860px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="th">Project</th>
                  <th className="th text-right">Time</th>
                  <th className="th">How</th>
                  {scope.kind === "company" && <th className="th">Who</th>}
                  <th className="th text-right">Claude prompts</th>
                  <th className="th text-right">Tokens</th>
                  <th className="th text-right">Commits</th>
                  <th className="th text-right">Billable</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="td">
                      <span className="flex items-center gap-2 font-medium">
                        <Dot color={r.color} />
                        {r.shared ? <span>{r.name}</span> : <Link className="hover:text-accent" href={`${scope.base}/projects/${r.id}?from=${range.from}&to=${range.to}`}>{r.name}</Link>}
                      </span>
                      <span className="block pl-[18px] text-xs text-muted">
                        {r.shared ? `${scope.org.name} project` : (r.clientId && clientName.get(r.clientId)) || "No client"}
                      </span>
                    </td>
                    <td className="td num text-right font-medium">
                      {hm(r.minutes)}
                      {r.background > 0 && <span className="block text-xs font-normal text-muted" title="Claude worked on this while the person was on something else. Shown, not billed.">+{hm(r.background)} Claude alone</span>}
                    </td>
                    <td className="td"><Split row={r} /></td>
                    {scope.kind === "company" && (
                      <td className="td text-xs text-muted">
                        {[...r.byMember.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => `${names.get(id) ?? "?"} ${hm(n)}`).join(" · ") || "–"}
                      </td>
                    )}
                    <td className="td num text-right">{r.prompts || "–"}</td>
                    <td className="td num text-right">{r.tokens ? compact(r.tokens) : "–"}</td>
                    <td className="td num text-right">
                      {r.commits || "–"}
                      {r.commits > 0 && <span className="block text-xs text-muted">+{r.added} / -{r.removed}</span>}
                    </td>
                    <td className="td num text-right">{r.shared || !r.rateCents ? "–" : money(Math.round((r.minutes / 60) * r.rateCents))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form action={createProject} className="card flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-40 flex-1">
            <label className="label" htmlFor="p-name">New project</label>
            <input className="input" id="p-name" name="name" required maxLength={80} placeholder="Nami Panel" />
          </div>
          <div className="w-44">
            <label className="label" htmlFor="p-client">Client</label>
            <select className="input" id="p-client" name="clientId" defaultValue="">
              <option value="">No client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="w-32">
            <label className="label" htmlFor="p-rate">Billed per hour ($)</label>
            <input className="input" id="p-rate" name="rate" type="number" min="0" step="0.01" placeholder="150" />
          </div>
          <button className="btn">Add project</button>
        </form>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="font-medium">Unsorted time</h2>
          <p className="text-sm text-muted">
            Say once where each of these belongs. It is saved as a rule, so past and future time like it sorts itself.
          </p>
        </div>
        {report.unsorted.length === 0 ? (
          <p className="card p-6 text-sm text-muted">Nothing to sort in these dates.</p>
        ) : (
          <ul className="card divide-y divide-border">
            {report.unsorted.slice(0, 40).map((g) => (
              <li key={`${g.field}:${g.match}:${g.app}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
                <div className="min-w-48 flex-1">
                  <p className="truncate text-sm font-medium">{g.label}</p>
                  <p className="text-xs text-muted">
                    {{ repo: "Folder or repository", site: "Website", title: "Window", app: "App", url: "Page" }[g.field]}
                    {scope.kind === "company" && ` · ${[...g.members].map((id) => names.get(id) ?? "?").join(", ")}`}
                  </p>
                </div>
                <span className="num text-sm font-medium">{hm(g.minutes)}</span>
                <form action={sortGroup} className="flex flex-wrap items-center justify-end gap-2">
                  <input type="hidden" name="field" value={g.field} />
                  <input type="hidden" name="match" value={g.match} />
                  <input type="hidden" name="app" value={g.app ?? ""} />
                  <input type="hidden" name="label" value={g.field === "title" ? g.match : g.label} />
                  <select className="input w-52" name="projectId" defaultValue={g.suggestedProjectId ?? ""} required aria-label={`Project for ${g.label}`}>
                    <option value="" disabled>Choose a project</option>
                    {mine.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}{g.suggestedProjectId === p.id ? " (suggested by Claude)" : ""}</option>
                    ))}
                    <option value="new">New project “{g.field === "title" ? g.match : g.label}”</option>
                  </select>
                  {g.wider && (
                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      <input type="checkbox" name="widerMatch" value={g.wider.match} />
                      and {g.wider.label}
                    </label>
                  )}
                  <button className="btn-quiet">Sort</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
