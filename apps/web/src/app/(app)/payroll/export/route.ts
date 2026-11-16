import { getSession } from "@/lib/auth";
import { payroll } from "@/lib/payroll";
import { periodDays } from "@/lib/report";

function cell(value: string | number): string {
  let s = String(value);
  // Stop spreadsheet apps treating a name as a formula.
  if (/^[=+\-@\t\r]/.test(s) && typeof value === "string") s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const hours = (minutes: number) => (minutes / 60).toFixed(2);

export async function GET(req: Request) {
  const session = await getSession();
  if (!session || session.kind !== "owner") return new Response("Not signed in", { status: 401 });
  const { period, rows } = await payroll(session.org, new URL(req.url).searchParams.get("p") ?? undefined);
  const days = periodDays(period);
  const lines = [
    ["Person", ...days, "Tracked hours", "Thin evidence hours", "Hours added by hand", "Hours to pay", "Hourly rate", "Amount"],
    ...rows.map((r) => [
      r.name,
      ...r.days.map(hours),
      hours(r.verifiedMinutes),
      hours(r.weakMinutes),
      hours(r.adjustmentMinutes),
      hours(r.payableMinutes),
      (r.hourlyRateCents / 100).toFixed(2),
      (r.amountCents / 100).toFixed(2),
    ]),
  ];
  const csv = lines.map((l) => l.map(cell).join(",")).join("\r\n") + "\r\n";
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="payroll-${period.start}-to-${period.end}.csv"`,
    },
  });
}
