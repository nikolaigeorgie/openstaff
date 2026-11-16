import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { randomToken, sha256 } from "@/lib/crypto";

const Body = z.object({
  code: z.string().min(4).max(32),
  platform: z.string().max(40).optional(),
  hostname: z.string().max(120).optional(),
  appVersion: z.string().max(40).optional(),
});

/** The desktop app trades an invite code for a long-lived device token. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const code = parsed.data.code.trim().toUpperCase();

  const [invite] = await db
    .update(schema.invites)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.invites.code, code), isNull(schema.invites.usedAt), gt(schema.invites.expiresAt, new Date())))
    .returning();
  if (!invite) {
    return Response.json({ error: "That code is not valid, was already used, or has expired." }, { status: 404 });
  }

  const [row] = await db
    .select({ member: schema.members, org: schema.orgs })
    .from(schema.members)
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.members.orgId))
    .where(and(eq(schema.members.id, invite.memberId), isNull(schema.members.archivedAt)))
    .limit(1);
  if (!row) return Response.json({ error: "This person is no longer on the team." }, { status: 404 });

  const token = randomToken();
  await db.insert(schema.devices).values({
    memberId: row.member.id,
    tokenHash: sha256(token),
    platform: parsed.data.platform,
    hostname: parsed.data.hostname,
    appVersion: parsed.data.appVersion,
    lastSeenAt: new Date(),
  });
  return Response.json({ token, member: row.member.name, org: row.org.name });
}
