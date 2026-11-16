import Link from "next/link";
import { logout } from "@/app/actions";
import { requireOwner } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { org, user } = await requireOwner();
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/team" className="font-semibold tracking-tight">Open Staff</Link>
          <nav className="flex gap-4 text-sm">
            <Link href="/team" className="hover:text-accent">Team</Link>
            <Link href="/payroll" className="hover:text-accent">Payroll</Link>
            <Link href="/settings" className="hover:text-accent">Settings</Link>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-muted">
            <span className="hidden sm:inline">{org.name} · {user.name}</span>
            <form action={logout}><button className="underline">Log out</button></form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
