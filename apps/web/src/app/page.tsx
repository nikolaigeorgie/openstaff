import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";

const points = [
  ["No clocking in", "A small app starts with the computer and notices when work happens. Nobody has to remember a timer."],
  ["Only real work counts", "Minutes count when there is typing, clicking, Claude working on their prompt, or a commit. Idle time drops out."],
  ["Same numbers for both sides", "Each person sees exactly what is recorded about them, so the pay figure is hard to dispute."],
  ["No screenshots, no keystrokes", "It counts activity and names the app in front. It never records what is typed or shown."],
];

export default async function Home() {
  const session = await getSession();
  if (session) redirect(session.kind === "owner" ? "/team" : "/me");
  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:py-24">
      <p className="text-lg font-semibold tracking-tight">Open Staff</p>
      <h1 className="mt-10 text-4xl font-semibold tracking-tight sm:text-5xl">
        Pay for the hours that were actually worked.
      </h1>
      <p className="mt-5 max-w-xl text-lg text-muted">
        Verified work hours for teams that work on a computer, mostly with Claude. Built to be fair to the
        owner and to the people doing the work.
      </p>
      <div className="mt-8 flex gap-3">
        <Link className="btn" href="/signup">Set up your team</Link>
        <Link className="btn-quiet" href="/login">Log in</Link>
      </div>
      <dl className="mt-16 grid gap-4 sm:grid-cols-2">
        {points.map(([title, body]) => (
          <div key={title} className="card p-5">
            <dt className="font-medium">{title}</dt>
            <dd className="mt-1.5 text-sm text-muted">{body}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
