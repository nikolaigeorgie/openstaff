import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getSession } from "@/lib/auth";

export default async function Page({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const session = await getSession();
  if (session) redirect(session.kind === "owner" ? "/team" : "/me");
  const { expired } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <Link href="/" className="mb-8 text-lg font-semibold tracking-tight">Open Staff</Link>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Set up your team</h1>
      {expired && (
        <p className="mb-4 text-sm text-muted">
          That link has expired. Open your page again from the Open Staff icon in your menu bar or tray.
        </p>
      )}
      <AuthForm mode="signup" />
    </main>
  );
}
