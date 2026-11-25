import Link from "next/link";
import { deleteClient, saveClient } from "@/app/actions";
import { longDay, money } from "@/lib/format";
import { lastMonth } from "@/lib/invoices";
import { rangeFor } from "@/lib/projects";
import { scopeClients, scopeInvoices, scopeProjects, type Scope } from "@/lib/scope";
import { ConfirmButton, SaveButton } from "./form-buttons";
import { InvoiceForm } from "./invoice-form";

export const invoiceNo = (n: number) => `INV-${String(n).padStart(4, "0")}`;

export async function InvoicesView({ scope }: { scope: Scope }) {
  const [clients, invoices, projects] = await Promise.all([scopeClients(scope), scopeInvoices(scope), scopeProjects(scope)]);
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const [from, to] = lastMonth(rangeFor(scope).to);
  const list = [...invoices].sort((a, b) => b.number - a.number);
  const owed = list.filter((i) => i.status === "sent").reduce((n, i) => n + i.totalCents, 0);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{scope.kind === "personal" ? "My invoices" : "Invoices"}</h1>
        <p className="text-sm text-muted">
          {scope.kind === "personal"
            ? `Your own clients. ${scope.org.name} cannot see these, and time on them is not counted as time for ${scope.org.name}.`
            : "Bill clients for the time sorted into their projects."}
        </p>
      </div>

      {clients.length > 0 && <InvoiceForm clients={clients.map((c) => ({ id: c.id, name: c.name }))} from={from} to={to} />}

      {list.length > 0 && (
        <section className="space-y-2">
          <p className="text-sm text-muted">{owed ? `${money(owed)} sent and not yet paid` : "Nothing waiting to be paid"}</p>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="th">Invoice</th><th className="th">Client</th><th className="th">Work dates</th><th className="th">Status</th><th className="th text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.id} className="border-b border-border last:border-0">
                    <td className="td font-medium"><Link className="hover:text-accent" href={`${scope.base}/invoices/${i.id}`}>{invoiceNo(i.number)}</Link></td>
                    <td className="td">{clientName.get(i.clientId) ?? "?"}</td>
                    <td className="td text-muted">{longDay(i.fromDay)} to {longDay(i.toDay)}</td>
                    <td className="td capitalize">{i.status}</td>
                    <td className="td num text-right font-medium">{money(i.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-medium">Clients</h2>
        {clients.length === 0 && (
          <p className="text-sm text-muted">Add a client, then give them a project on the Projects page. Invoices are built from that project&apos;s time.</p>
        )}
        {clients.map((c) => {
          const theirs = projects.filter((p) => p.clientId === c.id);
          return (
            <div key={c.id} className="card space-y-3 p-4">
              <form action={saveClient} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="clientId" value={c.id} />
                <div className="w-56">
                  <label className="label" htmlFor={`c-name-${c.id}`}>Client</label>
                  <input className="input" id={`c-name-${c.id}`} name="name" required maxLength={120} defaultValue={c.name} />
                </div>
                <div className="min-w-48 flex-1">
                  <label className="label" htmlFor={`c-details-${c.id}`}>Printed on invoices (address, contact)</label>
                  <input className="input" id={`c-details-${c.id}`} name="details" maxLength={1000} defaultValue={c.details} />
                </div>
                <SaveButton />
              </form>
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
                <span>{theirs.length ? `Projects: ${theirs.map((p) => p.name).join(", ")}` : "No projects yet. Set this client on a project to bill it."}</span>
                <form action={deleteClient}>
                  <input type="hidden" name="clientId" value={c.id} />
                  <ConfirmButton label="Delete client" confirm="Click again to delete the client and its invoices" />
                </form>
              </div>
            </div>
          );
        })}
        <form action={saveClient} className="card flex flex-wrap items-end gap-3 p-4">
          <div className="w-56">
            <label className="label" htmlFor="c-new">New client</label>
            <input className="input" id="c-new" name="name" required maxLength={120} placeholder="Slab Dynasty LLC" />
          </div>
          <div className="min-w-48 flex-1">
            <label className="label" htmlFor="c-new-details">Printed on invoices (address, contact)</label>
            <input className="input" id="c-new-details" name="details" maxLength={1000} placeholder="12 Main St, Austin TX · ap@example.com" />
          </div>
          <button className="btn">Add client</button>
        </form>
      </section>
    </div>
  );
}
