import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteInvoice, setInvoiceStatus, updateInvoice } from "@/app/actions";
import { longDay, money } from "@/lib/format";
import { scopeClient, scopeInvoice, type Scope } from "@/lib/scope";
import { ConfirmButton, SaveButton } from "./form-buttons";
import { PrintButton } from "./invoice-form";
import { invoiceNo } from "./invoices-view";

const hours = (minutes: number) => (minutes / 60).toFixed(2);

export async function InvoiceDetail({ scope, id }: { scope: Scope; id: string }) {
  const invoice = await scopeInvoice(scope, id);
  if (!invoice) notFound();
  const client = await scopeClient(scope, invoice.clientId);
  const draft = invoice.status === "draft";
  const next = draft ? "sent" : invoice.status === "sent" ? "paid" : null;
  return (
    <div className="space-y-5">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <Link href={`${scope.base}/invoices`} className="text-sm text-muted hover:text-accent">← Invoices</Link>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm capitalize text-muted">{invoice.status}</span>
          {next && (
            <form action={setInvoiceStatus}>
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <input type="hidden" name="status" value={next} />
              <button className="btn-quiet">Mark as {next}</button>
            </form>
          )}
          {!draft && (
            <form action={setInvoiceStatus}>
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <input type="hidden" name="status" value="draft" />
              <button className="btn-quiet">Back to draft</button>
            </form>
          )}
          <a className="btn-quiet" href={`${scope.base}/invoices/${invoice.id}/csv`}>Download CSV</a>
          <PrintButton />
        </div>
      </div>

      <article className="card invoice mx-auto max-w-3xl space-y-8 p-8">
        <header className="flex flex-wrap justify-between gap-6">
          <div>
            <p className="text-xl font-semibold tracking-tight">{scope.sender}</p>
            <p className="mt-6 text-xs text-muted">Billed to</p>
            <p className="font-medium">{client?.name}</p>
            {client?.details && <p className="max-w-xs whitespace-pre-line text-sm text-muted">{client.details}</p>}
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tracking-tight">Invoice</p>
            <p className="num text-sm text-muted">{invoiceNo(invoice.number)}</p>
            <p className="mt-4 text-xs text-muted">Date</p>
            <p className="text-sm">{longDay(invoice.issuedOn)}, {invoice.issuedOn.slice(0, 4)}</p>
            <p className="mt-2 text-xs text-muted">For work</p>
            <p className="text-sm">{longDay(invoice.fromDay)} to {longDay(invoice.toDay)}</p>
          </div>
        </header>

        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="th pl-0">Description</th><th className="th text-right">Hours</th><th className="th text-right">Rate</th><th className="th pr-0 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l, i) => (
              <tr key={i} className="border-b border-border">
                <td className="td pl-0">{l.description}</td>
                <td className="td num text-right">{hours(l.minutes)}</td>
                <td className="td num text-right">{money(l.rateCents)}</td>
                <td className="td num pr-0 text-right">{money(l.amountCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="td pl-0 font-semibold" colSpan={3}>Total due</td>
              <td className="td num pr-0 text-right text-lg font-semibold">{money(invoice.totalCents)}</td>
            </tr>
          </tfoot>
        </table>
        {invoice.notes && <p className="whitespace-pre-line text-sm text-muted">{invoice.notes}</p>}
      </article>

      <section className="no-print card mx-auto max-w-3xl p-5">
        {draft ? (
          <>
            <h2 className="text-sm font-medium">Edit before sending</h2>
            <p className="mt-1 text-sm text-muted">Hours come from the time sorted into each project. Change anything the client should not see as it is.</p>
            <form action={updateInvoice} className="mt-3 space-y-3">
              <input type="hidden" name="invoiceId" value={invoice.id} />
              {invoice.lines.map((l, i) => (
                <div key={i} className="flex flex-wrap items-end gap-3">
                  <div className="min-w-48 flex-1">
                    <label className="label" htmlFor={`description-${i}`}>Description</label>
                    <input className="input" id={`description-${i}`} name={`description-${i}`} defaultValue={l.description} maxLength={200} required />
                  </div>
                  <div className="w-24">
                    <label className="label" htmlFor={`hours-${i}`}>Hours</label>
                    <input className="input" id={`hours-${i}`} name={`hours-${i}`} type="number" min="0" step="0.01" defaultValue={hours(l.minutes)} />
                  </div>
                  <div className="w-28">
                    <label className="label" htmlFor={`rate-${i}`}>Rate ($)</label>
                    <input className="input" id={`rate-${i}`} name={`rate-${i}`} type="number" min="0" step="0.01" defaultValue={(l.rateCents / 100).toFixed(2)} />
                  </div>
                </div>
              ))}
              <div>
                <label className="label" htmlFor="notes">Note at the bottom (payment terms, bank details)</label>
                <textarea className="input" id="notes" name="notes" rows={2} maxLength={1000} defaultValue={invoice.notes} />
              </div>
              <SaveButton />
            </form>
          </>
        ) : (
          <p className="text-sm text-muted">This invoice is {invoice.status}, so its numbers are fixed. Put it back to draft to change it.</p>
        )}
        <form action={deleteInvoice} className="mt-4 border-t border-border pt-3">
          <input type="hidden" name="invoiceId" value={invoice.id} />
          <ConfirmButton label="Delete invoice" confirm="Click again to delete. Its time can then be invoiced again." />
        </form>
      </section>
    </div>
  );
}

export async function invoiceCsv(scope: Scope, id: string): Promise<Response> {
  const invoice = await scopeInvoice(scope, id);
  if (!invoice) return new Response("Not found", { status: 404 });
  const cell = (v: string | number) => {
    let s = String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    ["Description", "Hours", "Rate", "Amount"],
    ...invoice.lines.map((l) => [l.description, hours(l.minutes), (l.rateCents / 100).toFixed(2), (l.amountCents / 100).toFixed(2)]),
    ["Total", "", "", (invoice.totalCents / 100).toFixed(2)],
  ];
  return new Response(rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${invoiceNo(invoice.number)}.csv"` },
  });
}
