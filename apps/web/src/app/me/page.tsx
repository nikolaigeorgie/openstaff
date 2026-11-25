import { redirect } from "next/navigation";
import { PersonDay } from "@/components/person-day";
import { Refresher } from "@/components/refresher";
import { getSession } from "@/lib/auth";

/** The employee's own view: the same numbers the owner sees. */
export default async function MePage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const session = await getSession();
  if (!session || session.kind !== "member") redirect("/login?expired=1");
  const { day } = await searchParams;
  return (
    <div className="space-y-4">
      <Refresher seconds={60} />
      <p className="card p-4 text-sm text-muted">
        This is everything Open Staff records about you, and it is what {session.org.name} sees. It counts
        activity and notes what was in front: the app, the window title, the site and page, and the folder
        you were working in. It never records what you type, never takes screenshots and never records
        sound. Use Pause in the tray menu for private time. Time on your own projects (under My projects)
        is hidden from {session.org.name} and not counted for them.
      </p>
      <PersonDay member={session.member} org={session.org} day={day} basePath="/me" owner={false} />
    </div>
  );
}
