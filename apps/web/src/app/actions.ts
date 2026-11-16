"use server";

import { dayOfMinute, periodAt } from "@openstaff/core";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db, schema } from "@/db";
import { createSession, destroySession, requireOwner } from "@/lib/auth";
import { hashPassword, inviteCode, verifyPassword } from "@/lib/crypto";
import { periodReport } from "@/lib/report";

export type FormState = { error?: string; values?: Record<string, string> } | undefined;

function validTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "America/New_York";
  }
}

/** Monday of the current week in the given timezone. */
function thisMonday(tz: string): string {
  const today = dayOfMinute(Math.floor(Date.now() / 60_000), tz);
  const [y, m, d] = today.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

const Signup = z.object({
  company: z.string().trim().min(1, "Enter your company name").max(80),
  name: z.string().trim().min(1, "Enter your name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Use at least 8 characters").max(200),
  timezone: z.string().max(60).default("America/New_York"),
});

export async function signup(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = {
    company: String(formData.get("company") ?? ""),
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
  };
  const parsed = Signup.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message, values };
  const { company, name, email, password } = parsed.data;
  const timezone = validTimezone(parsed.data.timezone);
  const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (existing) return { error: "There is already an account with that email. Log in instead.", values };
  const [org] = await db
    .insert(schema.orgs)
    .values({ name: company, timezone, periodAnchor: thisMonday(timezone) })
    .returning();
  const [user] = await db
    .insert(schema.users)
    .values({ orgId: org.id, email, name, passwordHash: await hashPassword(password) })
    .returning();
  await createSession({ userId: user.id });
  redirect("/settings?welcome=1");
}

export async function login(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return { error: "Wrong email or password.", values: { email } };
  }
  await createSession({ userId: user.id });
  redirect("/team");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

function cents(value: FormDataEntryValue | null): number {
  const n = Number(String(value ?? "0").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.min(Math.round(n * 100), 100_000_00) : 0;
}

/** A member of the signed-in owner's own team, or nothing. */
async function ownMember(orgId: string, memberId: string) {
  if (!z.string().uuid().safeParse(memberId).success) return null;
  const [member] = await db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, memberId), eq(schema.members.orgId, orgId)))
    .limit(1);
  return member ?? null;
}

async function newInvite(memberId: string) {
  await db.insert(schema.invites).values({
    code: inviteCode(),
    memberId,
    expiresAt: new Date(Date.now() + 14 * 86_400_000),
  });
}

export async function addMember(formData: FormData) {
  const { org } = await requireOwner();
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  if (!name) return;
  const [member] = await db
    .insert(schema.members)
    .values({ orgId: org.id, name, hourlyRateCents: cents(formData.get("rate")) })
    .returning();
  await newInvite(member.id);
  revalidatePath("/settings");
}

export async function updateMember(formData: FormData) {
  const { org } = await requireOwner();
  const member = await ownMember(org.id, String(formData.get("memberId")));
  if (!member) return;
  const name = String(formData.get("name") ?? "").trim().slice(0, 80) || member.name;
  await db
    .update(schema.members)
    .set({ name, hourlyRateCents: cents(formData.get("rate")) })
    .where(eq(schema.members.id, member.id));
  revalidatePath("/settings");
}

export async function archiveMember(formData: FormData) {
  const { org } = await requireOwner();
  const member = await ownMember(org.id, String(formData.get("memberId")));
  if (!member) return;
  await db.update(schema.members).set({ archivedAt: new Date() }).where(eq(schema.members.id, member.id));
  revalidatePath("/settings");
}

export async function createInvite(formData: FormData) {
  const { org } = await requireOwner();
  const member = await ownMember(org.id, String(formData.get("memberId")));
  if (!member) return;
  await db
    .delete(schema.invites)
    .where(and(eq(schema.invites.memberId, member.id), isNull(schema.invites.usedAt)));
  await newInvite(member.id);
  revalidatePath("/settings");
}

export async function revokeDevice(formData: FormData) {
  const { org } = await requireOwner();
  const deviceId = String(formData.get("deviceId"));
  if (!z.string().uuid().safeParse(deviceId).success) return;
  const [row] = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .innerJoin(schema.members, eq(schema.members.id, schema.devices.memberId))
    .where(and(eq(schema.devices.id, deviceId), eq(schema.members.orgId, org.id)));
  if (!row) return;
  await db.update(schema.devices).set({ revokedAt: new Date() }).where(eq(schema.devices.id, row.id));
  revalidatePath("/settings");
}

export async function updateOrg(formData: FormData) {
  const { org } = await requireOwner();
  const name = String(formData.get("name") ?? "").trim().slice(0, 80) || org.name;
  const timezone = validTimezone(String(formData.get("timezone") ?? org.timezone));
  const anchor = String(formData.get("periodAnchor") ?? org.periodAnchor);
  await db
    .update(schema.orgs)
    .set({ name, timezone, periodAnchor: /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : org.periodAnchor })
    .where(eq(schema.orgs.id, org.id));
  revalidatePath("/", "layout");
}

export async function addAdjustment(formData: FormData) {
  const { org, user } = await requireOwner();
  const member = await ownMember(org.id, String(formData.get("memberId")));
  const day = String(formData.get("day") ?? "");
  const hours = Number(formData.get("hours"));
  const note = String(formData.get("note") ?? "").trim().slice(0, 200);
  if (!member || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(hours) || hours === 0 || !note) return;
  const minutes = Math.max(-1440, Math.min(1440, Math.round(hours * 60)));
  await db.insert(schema.adjustments).values({ memberId: member.id, day, minutes, note, createdBy: user.id });
  revalidatePath(`/people/${member.id}`);
  revalidatePath("/payroll");
}

export async function deleteAdjustment(formData: FormData) {
  const { org } = await requireOwner();
  const id = String(formData.get("id"));
  if (!z.string().uuid().safeParse(id).success) return;
  const [row] = await db
    .select({ id: schema.adjustments.id, memberId: schema.adjustments.memberId })
    .from(schema.adjustments)
    .innerJoin(schema.members, eq(schema.members.id, schema.adjustments.memberId))
    .where(and(eq(schema.adjustments.id, id), eq(schema.members.orgId, org.id)));
  if (!row) return;
  await db.delete(schema.adjustments).where(eq(schema.adjustments.id, row.id));
  revalidatePath(`/people/${row.memberId}`);
  revalidatePath("/payroll");
}

export async function lockPeriod(formData: FormData) {
  const { org } = await requireOwner();
  const index = Number(formData.get("index"));
  if (!Number.isInteger(index)) return;
  const rows = await periodReport(org, periodAt(index, org.periodAnchor, org.periodDays));
  await db
    .insert(schema.periodLocks)
    .values({ orgId: org.id, periodIndex: index, snapshot: rows })
    .onConflictDoNothing();
  revalidatePath("/payroll");
}

export async function unlockPeriod(formData: FormData) {
  const { org } = await requireOwner();
  const index = Number(formData.get("index"));
  if (!Number.isInteger(index)) return;
  await db
    .delete(schema.periodLocks)
    .where(and(eq(schema.periodLocks.orgId, org.id), eq(schema.periodLocks.periodIndex, index)));
  revalidatePath("/payroll");
}
