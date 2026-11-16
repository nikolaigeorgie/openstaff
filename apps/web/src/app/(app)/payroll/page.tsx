import Link from "next/link";
import { lockPeriod, unlockPeriod } from "@/app/actions";
import { requireOwner } from "@/lib/auth";
import { hm, longDay, money } from "@/lib/format";
import { payroll } from "@/lib/payroll";
import { periodDays } from "@/lib/report";

export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const { org } = await requireOwner();
  const { p } = await searchParams;
  const { period, currentIndex, rows, lockedAt } = await payroll(org, p);
  const days = periodDays(period);
  const total = rows.reduce((n, r) => n + r.amountCents, 0);
  const totalMinutes = rows.reduce((n, r) => n + r.payableMinutes, 0);
  const isCurrent = period.index === currentIndex;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Payroll</h1>
          <p className="text-sm text-muted">
            {longDay(period.start)} to {longDay(period.end)}
            {isCurrent ? " · in progress" : ""}
            {lockedAt ? " · locked" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="btn-quiet" href={`/payroll?p=${period.index - 1}`}>← Earlier</Link>
          {!isCurrent && <Link className="btn-quiet" href={`/payroll?p=${period.index + 1}`}>Later →</Link>}
          <a className="btn-quiet" href={`/payroll/export?p=${period.index}`}>Download CSV</a>
          <form action={lockedAt ? unlockPeriod : lockPeriod}>
            <input type="hidden" name="index" value={period.index} />
            <button className={lockedAt ? "btn-quiet" : "btn"}>{lockedAt ? "Unlock" : "Lock period"}</button>
          </form>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <div className="card p-4">
          <p className="text-xs text-muted">Total to pay</p>
          <p className="num mt-1 text-2xl font-semibold tracking-tight">{money(total)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Hours to pay</p>
          <p className="num mt-1 text-2xl font-semibold tracking-tight">{hm(totalMinutes)}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="card p-6 text-sm text-muted">Nobody on the team yet. Add people in Settings.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead>
              <tr className="border-b border-border">
                <th className="th">Person</th>
                <th className="th">Day by day</th>
                <th className="th text-right">Tracked</th>
                <th className="th text-right">Added by hand</th>
                <th className="th text-right">Hours to pay</th>
                <th className="th text-right">Rate</th>
                <th className="th text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.memberId} className="border-b border-border last:border-0">
                  <td className="td font-medium">
                    <Link className="hover:text-accent" href={`/people/${r.memberId}?day=${period.start}`}>{r.name}</Link>
                  </td>
                  <td className="td">
                    <div className="flex items-end gap-0.5">
                      {r.days.map((minutes, i) => (
                        <Link
                          key={days[i]}
                          href={`/people/${r.memberId}?day=${days[i]}`}
                          title={`${longDay(days[i])}: ${hm(minutes)}`}
                          className="flex h-7 w-2.5 items-end rounded-sm bg-bg"
                        >
                          <span className="w-full rounded-sm bg-active" style={{ height: `${Math.min(100, (minutes / 480) * 100)}%` }} />
                        </Link>
                      ))}
                    </div>
                  </td>
                  <td className="td num text-right">
                    {hm(r.verifiedMinutes)}
                    {r.weakMinutes > 0 && <span className="block text-xs text-weak">{hm(r.weakMinutes)} thin evidence</span>}
                  </td>
                  <td className="td num text-right">{r.adjustmentMinutes ? hm(r.adjustmentMinutes) : "–"}</td>
                  <td className="td num text-right font-medium">{hm(r.payableMinutes)}</td>
                  <td className="td num text-right text-muted">{money(r.hourlyRateCents)}/h</td>
                  <td className="td num text-right font-semibold">{money(r.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm text-muted">
        {lockedAt
          ? "This period is locked. The numbers above are the ones you approved and will not change."
          : "Lock a period once you have paid it. The numbers are then frozen, whatever arrives later."}
      </p>
    </div>
  );
}
