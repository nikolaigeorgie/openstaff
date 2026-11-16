import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { randomToken, sha256 } from "./crypto";

const COOKIE = "os_session";
const OWNER_DAYS = 30;
const MEMBER_DAYS = 1;

export type Org = typeof schema.orgs.$inferSelect;
export type User = typeof schema.users.$inferSelect;
export type Member = typeof schema.members.$inferSelect;

export type Session =
  | { kind: "owner"; user: User; org: Org }
  | { kind: "member"; member: Member; org: Org };

export async function createSession(who: { userId: string } | { memberId: string }) {
  const token = randomToken();
  const days = "userId" in who ? OWNER_DAYS : MEMBER_DAYS;
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  await db.insert(schema.sessions).values({ tokenHash: sha256(token), expiresAt, ...who });
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
  jar.delete(COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  const [row] = await db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;
  if (row.userId) {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
    if (!user) return null;
    const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, user.orgId)).limit(1);
    return org ? { kind: "owner", user, org } : null;
  }
  if (row.memberId) {
    const [member] = await db.select().from(schema.members).where(eq(schema.members.id, row.memberId)).limit(1);
    if (!member) return null;
    const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, member.orgId)).limit(1);
    return org ? { kind: "member", member, org } : null;
  }
  return null;
}

/** For owner-only pages and actions. Employees are sent to their own page. */
export async function requireOwner() {
  const s = await getSession();
  if (!s) redirect("/login");
  if (s.kind !== "owner") redirect("/me");
  return s;
}

/** The device behind a desktop app request (Authorization: Bearer <token>). */
export async function deviceFromRequest(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const [row] = await db
    .select({ device: schema.devices, member: schema.members, org: schema.orgs })
    .from(schema.devices)
    .innerJoin(schema.members, eq(schema.members.id, schema.devices.memberId))
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.members.orgId))
    .where(
      and(
        eq(schema.devices.tokenHash, sha256(token)),
        isNull(schema.devices.revokedAt),
        isNull(schema.members.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
