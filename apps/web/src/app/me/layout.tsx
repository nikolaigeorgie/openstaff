import Link from "next/link";
import { redirect } from "next/navigation";
import { logout } from "@/app/actions";
import { getSession } from "@/lib/auth";

/** A person's own pages, opened from the tray: their day, their own projects and invoices. */
export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login?expired=1");
  if (session.kind === "owner") redirect("/team");
  return (
    <div className="min-h-screen">
      <header className="no-print border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold tracking-tight">Open Staff</span>
          <nav className="flex gap-4 text-sm">
            <Link href="/me" className="hover:text-accent">My day</Link>
            <Link href="/me/projects" className="hover:text-accent">My projects</Link>
            <Link href="/me/invoices" className="hover:text-accent">My invoices</Link>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-muted">
            <span className="hidden sm:inline">{session.member.name} · {session.org.name}</span>
            <form action={logout}><button className="underline">Close</button></form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
