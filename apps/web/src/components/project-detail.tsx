import { contextKey } from "@openstaff/core";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { addRule, deleteProject, deleteRule, updateProject } from "@/app/actions";
import { db, schema } from "@/db";
import { compact, hm, longDay, money } from "@/lib/format";
import { FIELD_NAMES, projectReport, rangeFor } from "@/lib/projects";
import { worked } from "@/lib/report";
import { COLORS, scopeClients, scopeProject, type Scope } from "@/lib/scope";
import { ConfirmButton, SaveButton } from "./form-buttons";
import { Split } from "./projects-view";

export async function ProjectDetail({ scope, id, from, to }: { scope: Scope; id: string; from?: string; to?: string }) {
  const project = await scopeProject(scope, id);
  if (!project) notFound();
  const range = rangeFor(scope, from, to);
  const [report, clients, rules] = await Promise.all([
    projectReport(scope, range),
    scopeClients(scope),
    db.select().from(schema.rules).where(eq(schema.rules.projectId, project.id)),
  ]);
  const row = report.rows.find((r) => r.id === project.id)!;
  const names = new Map(scope.members.map((m) => [m.id, m.name]));
  const days = [...row.byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const maxDay = Math.max(1, ...days.map(([, n]) => n));
  // What the time on this project actually was.
  const contexts = new Map<string, number>();
  for (const list of report.minutes.values()) {
    for (const v of list) {
      if (!worked(v) || v.projectId !== project.id) continue;
      const label = contextKey(v)?.label ?? "Other";
      contexts.set(label, (contexts.get(label) ?? 0) + 1);
    }
  }
  const top = [...contexts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return (
    <div className="space-y-6">
      <Link href={`${scope.base}/projects?from=${range.from}&to=${range.to}`} className="text-sm text-muted hover:text-accent">← Projects</Link>
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: project.color }} />
          {project.name}
        </h1>
        <p className="text-sm text-muted">{longDay(range.from)} to {longDay(range.to)}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs text-muted">Time</p>
          <p className="num mt-1 text-2xl font-semibold tracking-tight">{hm(row.minutes)}</p>
          <div className="mt-2"><Split row={row} /></div>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Billable</p>
          <p className="num mt-1 text-2xl font-semibold tracking-tight">{money(Math.round((row.minutes / 60) * project.rateCents))}</p>
          <p className="mt-0.5 text-xs text-muted">{money(project.rateCents)} per hour</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Claude</p>
          <p className="num mt-1 text-2xl font-semibold tracking-tight">{row.prompts} prompts</p>
          <p className="mt-0.5 text-xs text-muted">{compact(row.tokens)} tokens · {hm(row.claude)} waiting · {hm(row.background)} working alone</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Commits</p>
          <p className="num mt-1 text-2xl font-semibold tracking-tight">{row.commits}</p>
          <p className="mt-0.5 text-xs text-muted">+{row.added} / -{row.removed} lines · {compact(row.keys)} keys and clicks</p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="text-sm font-medium">Day by day</h2>
          {days.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No time on this project in these dates.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {days.map(([day, n]) => (
                <li key={day} className="flex items-center gap-3 text-sm">
                  <span className="w-24 shrink-0 text-muted">{longDay(day)}</span>
                  <span className="h-2 flex-1 rounded-full bg-bg"><span className="block h-2 rounded-full" style={{ width: `${(n * 100) / maxDay}%`, background: project.color }} /></span>
                  <span className="num w-16 shrink-0 text-right">{hm(n)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card p-5">
          <h2 className="text-sm font-medium">What the time was</h2>
          {top.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nothing yet.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {top.map(([label, n]) => (
                <li key={label} className="flex justify-between gap-3 text-sm"><span className="truncate">{label}</span><span className="num shrink-0 text-muted">{hm(n)}</span></li>
              ))}
            </ul>
          )}
          {scope.kind === "company" && row.byMember.size > 0 && (
            <>
              <h2 className="mt-5 text-sm font-medium">Who</h2>
              <ul className="mt-2 space-y-1.5">
                {[...row.byMember.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => (
                  <li key={id} className="flex justify-between gap-3 text-sm">
                    <Link className="hover:text-accent" href={`/people/${id}`}>{names.get(id) ?? "?"}</Link>
                    <span className="num text-muted">{hm(n)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <section className="card space-y-3 p-5">
        <div>
          <h2 className="text-sm font-medium">What counts as this project</h2>
          <p className="mt-1 text-sm text-muted">Time matching any of these is sorted here by itself. Changing them re-sorts past time too.</p>
        </div>
        {rules.length > 0 && (
          <ul className="divide-y divide-border">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>
                  <span className="text-muted">{FIELD_NAMES[r.field as keyof typeof FIELD_NAMES] ?? r.field}</span>{" "}
                  <span className="font-mono text-xs">{r.match}</span>
                  {r.app && <span className="text-muted"> in {r.app}</span>}
                </span>
                <form action={deleteRule}>
                  <input type="hidden" name="id" value={r.id} />
                  <button className="text-xs text-muted underline">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form action={addRule} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="projectId" value={project.id} />
          <div className="w-56">
            <label className="label" htmlFor="r-field">When the</label>
            <select className="input" id="r-field" name="field" defaultValue="repo">
              <option value="repo">repository or folder is</option>
              <option value="url">page address starts with</option>
              <option value="site">website is</option>
              <option value="title">window title contains</option>
              <option value="app">app is</option>
            </select>
          </div>
          <div className="min-w-48 flex-1">
            <label className="label" htmlFor="r-match">Text</label>
            <input className="input" id="r-match" name="match" required maxLength={300} placeholder="slabdynasty, admin.nami.com/panel, #nami-dev" />
          </div>
          <button className="btn-quiet">Add rule</button>
        </form>
      </section>

      <section className="card p-5">
        <h2 className="text-sm font-medium">Details</h2>
        <form action={updateProject} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="projectId" value={project.id} />
          <div className="min-w-40 flex-1">
            <label className="label" htmlFor="d-name">Name</label>
            <input className="input" id="d-name" name="name" required maxLength={80} defaultValue={project.name} />
          </div>
          <div className="w-44">
            <label className="label" htmlFor="d-client">Client</label>
            <select className="input" id="d-client" name="clientId" defaultValue={project.clientId ?? ""}>
              <option value="">No client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="w-32">
            <label className="label" htmlFor="d-rate">Billed per hour ($)</label>
            <input className="input" id="d-rate" name="rate" type="number" min="0" step="0.01" defaultValue={(project.rateCents / 100).toFixed(2)} />
          </div>
          <div className="w-28">
            <label className="label" htmlFor="d-color">Colour</label>
            <select className="input" id="d-color" name="color" defaultValue={project.color}>
              {COLORS.map((c, i) => <option key={c} value={c}>Colour {i + 1}</option>)}
            </select>
          </div>
          <SaveButton />
        </form>
        <form action={deleteProject} className="mt-4 border-t border-border pt-3">
          <input type="hidden" name="projectId" value={project.id} />
          <ConfirmButton label="Delete this project" confirm="Click again to delete. Its time becomes unsorted." />
        </form>
      </section>
    </div>
  );
}
