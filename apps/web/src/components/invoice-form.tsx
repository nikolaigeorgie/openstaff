"use client";

import { useActionState } from "react";
import { createInvoice, type FormState } from "@/app/actions";

export function InvoiceForm({ clients, from, to }: { clients: { id: string; name: string }[]; from: string; to: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createInvoice, undefined);
  return (
    <form action={action} className="card space-y-3 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-44 flex-1">
          <label className="label" htmlFor="i-client">New invoice for</label>
          <select className="input" id="i-client" name="clientId" required defaultValue="">
            <option value="" disabled>Choose a client</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="i-from">Work from</label>
          <input className="input" id="i-from" name="from" type="date" required defaultValue={from} />
        </div>
        <div>
          <label className="label" htmlFor="i-to">To</label>
          <input className="input" id="i-to" name="to" type="date" required defaultValue={to} />
        </div>
        <button className="btn" disabled={pending}>{pending ? "Adding up…" : "Create invoice"}</button>
      </div>
      {state?.error && <p className="text-sm text-weak" role="alert">{state.error}</p>}
    </form>
  );
}

export function PrintButton() {
  return <button type="button" className="btn" onClick={() => window.print()}>Print or save as PDF</button>;
}
