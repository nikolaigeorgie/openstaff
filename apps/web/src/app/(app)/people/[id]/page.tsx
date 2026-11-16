import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PersonDay } from "@/components/person-day";
import { db, schema } from "@/db";
import { requireOwner } from "@/lib/auth";

export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  const { org } = await requireOwner();
  const { id } = await params;
  const { day } = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [member] = await db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, id), eq(schema.members.orgId, org.id)))
    .limit(1);
  if (!member) notFound();
  return (
    <div className="space-y-4">
      <Link href="/team" className="text-sm text-muted hover:text-accent">← Team</Link>
      <PersonDay member={member} org={org} day={day} basePath={`/people/${member.id}`} owner />
    </div>
  );
}
