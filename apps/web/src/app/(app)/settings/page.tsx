import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { addMember, archiveMember, createInvite, revokeDevice, updateMember, updateOrg } from "@/app/actions";
import { Copy } from "@/components/copy";
import { ConfirmButton, SaveButton } from "@/components/form-buttons";
import { db, schema } from "@/db";
import { requireOwner } from "@/lib/auth";
import { ago } from "@/lib/format";
import { activeMembers } from "@/lib/report";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { org } = await requireOwner();
  const { welcome } = await searchParams;
  const members = await activeMembers(org.id);
  const ids = members.map((m) => m.id);
  const [invites, devices] = ids.length
    ? await Promise.all([
        db
          .select()
          .from(schema.invites)
          .where(and(inArray(schema.invites.memberId, ids), isNull(schema.invites.usedAt), gt(schema.invites.expiresAt, new Date()))),
        db
          .select()
          .from(schema.devices)
          .where(and(inArray(schema.devices.memberId, ids), isNull(schema.devices.revokedAt)))
          .orderBy(desc(schema.devices.createdAt)),
      ])
    : [[], []];
  const h = await headers();
  const origin = process.env.PUBLIC_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        {welcome && (
          <p className="mt-2 text-sm text-muted">
            Welcome. Add the people you want to track below, then send each one their invite link.
          </p>
        )}
      </div>

      <section className="space-y-3">
        <h2 className="font-medium">People</h2>
        <form action={addMember} className="card flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-48 flex-1">
            <label className="label" htmlFor="new-name">Name</label>
            <input className="input" id="new-name" name="name" required maxLength={80} placeholder="Ania" />
          </div>
          <div className="w-32">
            <label className="label" htmlFor="new-rate">Hourly rate ($)</label>
            <input className="input" id="new-rate" name="rate" type="number" min="0" step="0.01" placeholder="25" />
          </div>
          <button className="btn">Add person</button>
        </form>

        {members.map((m) => {
          const invite = invites.find((i) => i.memberId === m.id);
          const mine = devices.filter((d) => d.memberId === m.id);
          const link = invite ? `${origin}/join/${invite.code}` : null;
          return (
            <div key={m.id} className="card space-y-4 p-4">
              <form action={updateMember} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="memberId" value={m.id} />
                <div className="min-w-48 flex-1">
                  <label className="label" htmlFor={`name-${m.id}`}>Name</label>
                  <input className="input" id={`name-${m.id}`} name="name" defaultValue={m.name} required maxLength={80} />
                </div>
                <div className="w-32">
                  <label className="label" htmlFor={`rate-${m.id}`}>Hourly rate ($)</label>
                  <input className="input" id={`rate-${m.id}`} name="rate" type="number" min="0" step="0.01" defaultValue={(m.hourlyRateCents / 100).toFixed(2)} />
                </div>
                <SaveButton />
              </form>

              <div className="text-sm">
                {mine.length === 0 ? (
                  <p className="text-muted">No computer connected yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {mine.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span>{d.hostname ?? "Computer"}</span>
                        <span className="text-muted">
                          {[d.platform, d.appVersion && `v${d.appVersion}`, `seen ${ago(d.lastSeenAt)}`].filter(Boolean).join(" · ")}
                        </span>
                        <form action={revokeDevice}>
                          <input type="hidden" name="deviceId" value={d.id} />
                          <ConfirmButton label="Disconnect" confirm="Click again to disconnect" />
                        </form>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3 text-sm">
                {link ? (
                  <>
                    <span className="text-muted">Invite link</span>
                    <code className="rounded bg-bg px-2 py-1 font-mono text-xs break-all">{link}</code>
                    <Copy text={link} label="Copy link" />
                    <a
                      className="btn-quiet"
                      href={`mailto:?subject=${encodeURIComponent(`Set up Open Staff for ${org.name}`)}&body=${encodeURIComponent(
                        `Hi ${m.name},\n\n${org.name} uses Open Staff to count work hours. There is no timer to start or stop.\n\nOpen this link to install it and connect your computer:\n${link}\n\nThe page shows exactly what it records and what it never records.`,
                      )}`}
                    >
                      Email invite
                    </a>
                  </>
                ) : (
                  <form action={createInvite}>
                    <input type="hidden" name="memberId" value={m.id} />
                    <button className="btn-quiet">{mine.length ? "Invite another computer" : "New invite link"}</button>
                  </form>
                )}
                <form action={archiveMember} className="ml-auto">
                  <input type="hidden" name="memberId" value={m.id} />
                  <ConfirmButton label="Remove from team" confirm={`Click again to remove ${m.name}`} />
                </form>
              </div>
            </div>
          );
        })}
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Company</h2>
        <form action={updateOrg} className="card grid gap-4 p-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="org-name">Company name</label>
            <input className="input" id="org-name" name="name" defaultValue={org.name} required maxLength={80} />
          </div>
          <div>
            <label className="label" htmlFor="org-tz">Timezone for days and pay periods</label>
            <input className="input" id="org-tz" name="timezone" defaultValue={org.timezone} required />
          </div>
          <div>
            <label className="label" htmlFor="org-anchor">A pay period starts on</label>
            <input className="input" id="org-anchor" name="periodAnchor" type="date" defaultValue={org.periodAnchor} required />
          </div>
          <p className="text-sm text-muted sm:col-span-2">
            Pay periods are two weeks long and repeat from that date.
          </p>
          <div className="sm:text-right"><SaveButton /></div>
        </form>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Before you start</h2>
        <p className="max-w-2xl text-sm text-muted">
          Tell your team in writing that Open Staff is in use and what it records. Many places require this.
          The app is always visible on their computer and shows them the same numbers you see.
        </p>
      </section>
    </div>
  );
}
