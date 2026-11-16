import { redirect } from "next/navigation";
import { logout } from "@/app/actions";
import { PersonDay } from "@/components/person-day";
import { Refresher } from "@/components/refresher";
import { getSession } from "@/lib/auth";

/** The employee's own view: the same numbers the owner sees. */
export default async function MePage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login?expired=1");
  if (session.kind === "owner") redirect("/team");
  const { day } = await searchParams;
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <span className="font-semibold tracking-tight">Open Staff</span>
          <span className="text-sm text-muted">{session.org.name}</span>
          <form action={logout} className="ml-auto"><button className="text-sm text-muted underline">Close</button></form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-8">
        <Refresher seconds={60} />
        <p className="card p-4 text-sm text-muted">
          This is everything Open Staff records about you, and it is exactly what {session.org.name} sees.
          It counts activity and notes which app or site is in front. It never records what you type or
          what is on your screen. Use Pause in the tray menu for private time.
        </p>
        <PersonDay member={session.member} org={session.org} day={day} basePath="/me" owner={false} />
      </main>
    </div>
  );
}
