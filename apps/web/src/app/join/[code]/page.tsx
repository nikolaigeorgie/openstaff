import { and, eq, gt, isNull } from "drizzle-orm";
import { Copy } from "@/components/copy";
import { db, schema } from "@/db";

const records = [
  "How much you type and click, as counts only",
  "Which app and window is in front, with its title",
  "In a browser, the site and page address (not what is on the page)",
  "The folder or repository you are working in",
  "Whether you are on a call (never the sound)",
  "Claude Code usage: prompts sent, project folder, tokens",
  "Your git commits: time, repository, size and subject line",
];
const never = [
  "What you type",
  "Screenshots or screen recording",
  "Sound from your microphone or calls",
  "Page contents, or anything in a private browser window",
  "Your Claude conversations or code",
];

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const [row] = await db
    .select({ member: schema.members, org: schema.orgs })
    .from(schema.invites)
    .innerJoin(schema.members, eq(schema.members.id, schema.invites.memberId))
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.members.orgId))
    .where(and(eq(schema.invites.code, code), isNull(schema.invites.usedAt), gt(schema.invites.expiresAt, new Date())))
    .limit(1);
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <p className="text-lg font-semibold tracking-tight">Open Staff</p>
      {!row ? (
        <>
          <h1 className="mt-8 text-2xl font-semibold tracking-tight">This invite is no longer valid</h1>
          <p className="mt-2 text-muted">It was already used or has expired. Ask for a new link.</p>
        </>
      ) : (
        <>
          <h1 className="mt-8 text-3xl font-semibold tracking-tight">Hi {row.member.name}</h1>
          <p className="mt-2 text-muted">
            {row.org.name} uses Open Staff to count work hours. There is no timer to start or stop. It runs
            quietly and counts the time you are actually working.
          </p>

          <ol className="mt-8 space-y-4">
            <li className="card p-5">
              <p className="font-medium">1. Install the app</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <a className="btn" href="/download/mac">Download for Mac</a>
                <a className="btn" href="/download/windows">Download for Windows</a>
              </div>
              <p className="mt-3 text-sm text-muted">
                The app is not signed yet, so your computer will warn you the first time.
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-muted">
                <li>
                  <span className="text-text">Mac:</span> drag Open Staff into Applications and open it. When the
                  warning appears, click Done. Then open System Settings, go to Privacy &amp; Security, scroll
                  down and click Open Anyway next to Open Staff.
                </li>
                <li>
                  <span className="text-text">Windows:</span> click More info, then Run anyway.
                </li>
              </ul>
            </li>
            <li className="card p-5">
              <p className="font-medium">2. Paste this code when it asks</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <code className="rounded-lg bg-bg px-4 py-2 font-mono text-xl tracking-widest">{code}</code>
                <Copy text={code} label="Copy code" />
              </div>
            </li>
          </ol>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <div className="card p-5">
              <p className="text-sm font-medium">What it records</p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-muted">{records.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
            <div className="card p-5">
              <p className="text-sm font-medium">What it never records</p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-muted">{never.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
          </div>
          <p className="mt-6 text-sm text-muted">
            You can see everything recorded about you at any time from the Open Staff icon in your menu bar or
            tray, and pause it for private time. Paused time is not counted.
          </p>
        </>
      )}
    </main>
  );
}
