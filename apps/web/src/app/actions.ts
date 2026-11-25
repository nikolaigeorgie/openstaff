"use server";

import { dayOfMinute, periodAt } from "@openstaff/core";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db, schema } from "@/db";
import { createSession, destroySession, requireOwner } from "@/lib/auth";
import { hashPassword, inviteCode, verifyPassword } from "@/lib/crypto";
import { amount, draftLines } from "@/lib/invoices";
import { periodReport } from "@/lib/report";
import { COLORS, getScope, scopeClient, scopeInvoice, scopeInvoices, scopeProject, scopeProjects, uuid, type Scope } from "@/lib/scope";

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

// ---------------------------------------------------------------------------------------------
// Projects, sorting, clients and invoices. These work for the owner (the company's) and for a
// person on their own pages (their private ones); getScope() decides which.

function refresh() {
  revalidatePath("/", "layout");
}

async function makeProject(scope: Scope, name: string, clientId?: string | null, rate?: FormDataEntryValue | null) {
  const count = (await scopeProjects(scope)).length;
  const [project] = await db
    .insert(schema.projects)
    .values({
      orgId: scope.org.id,
      ownerMemberId: scope.ownerMemberId,
      name: name.slice(0, 80),
      color: COLORS[count % COLORS.length],
      clientId: clientId ?? null,
      rateCents: cents(rate ?? null),
    })
    .returning();
  return project;
}

export async function createProject(formData: FormData) {
  const scope = await getScope();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const client = await scopeClient(scope, formData.get("clientId"));
  await makeProject(scope, name, client?.id, formData.get("rate"));
  refresh();
}

export async function updateProject(formData: FormData) {
  const scope = await getScope();
  const project = await scopeProject(scope, formData.get("projectId"));
  if (!project) return;
  const client = await scopeClient(scope, formData.get("clientId"));
  const color = String(formData.get("color") ?? project.color);
  await db
    .update(schema.projects)
    .set({
      name: String(formData.get("name") ?? "").trim().slice(0, 80) || project.name,
      clientId: client?.id ?? null,
      rateCents: cents(formData.get("rate")),
      color: /^#[0-9a-f]{6}$/i.test(color) ? color : project.color,
    })
    .where(eq(schema.projects.id, project.id));
  refresh();
}

export async function deleteProject(formData: FormData) {
  const scope = await getScope();
  const project = await scopeProject(scope, formData.get("projectId"));
  if (!project) return;
  await db.delete(schema.projects).where(eq(schema.projects.id, project.id));
  refresh();
  redirect(`${scope.base}/projects`);
}

const FIELDS = ["repo", "url", "title", "site", "app"] as const;

async function addRuleTo(projectId: string, field: string, match: string, app: string | null) {
  if (!(FIELDS as readonly string[]).includes(field) || !match) return;
  const [same] = await db
    .select({ id: schema.rules.id })
    .from(schema.rules)
    .where(and(eq(schema.rules.projectId, projectId), eq(schema.rules.field, field), eq(schema.rules.match, match)));
  if (!same) await db.insert(schema.rules).values({ projectId, field, match: match.slice(0, 300), app: app || null });
}

export async function addRule(formData: FormData) {
  const scope = await getScope();
  const project = await scopeProject(scope, formData.get("projectId"));
  if (!project) return;
  let match = String(formData.get("match") ?? "").trim();
  const field = String(formData.get("field"));
  if (field === "url" || field === "site") match = match.replace(/^https?:\/\//i, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  await addRuleTo(project.id, field, match, String(formData.get("app") ?? "").trim() || null);
  refresh();
}

export async function deleteRule(formData: FormData) {
  const scope = await getScope();
  const id = formData.get("id");
  if (!uuid(id)) return;
  const [row] = await db.select().from(schema.rules).where(eq(schema.rules.id, id)).limit(1);
  if (!row || !(await scopeProject(scope, row.projectId))) return;
  await db.delete(schema.rules).where(eq(schema.rules.id, id));
  refresh();
}

/**
 * From the Unsorted list: "time that looks like this belongs to that project", saved as a rule so
 * it sorts itself from now on, past time included. `projectId` may be "new" to make the project.
 */
export async function sortGroup(formData: FormData) {
  const scope = await getScope();
  const field = String(formData.get("field"));
  // Ticking "everything in this Slack" swaps the one channel for the whole workspace.
  const wider = String(formData.get("widerMatch") ?? "").trim();
  const match = wider || String(formData.get("match") ?? "").trim();
  const choice = String(formData.get("projectId") ?? "");
  if (!match || !choice) return;
  const project =
    choice === "new"
      ? await makeProject(scope, String(formData.get("newName") ?? "").trim() || String(formData.get("label") ?? match))
      : await scopeProject(scope, choice);
  if (!project) return;
  await addRuleTo(project.id, field, match, String(formData.get("app") ?? "").trim() || null);
  refresh();
}

/** Moves a stretch of one person's time to a project by hand. An empty project means unsorted. */
export async function assignTime(formData: FormData) {
  const scope = await getScope();
  const memberId = String(formData.get("memberId"));
  const member = scope.members.find((m) => m.id === memberId);
  const fromM = Number(formData.get("fromM"));
  const toM = Number(formData.get("toM"));
  if (!member || !Number.isInteger(fromM) || !Number.isInteger(toM) || toM <= fromM || toM - fromM > 1440) return;
  const choice = String(formData.get("projectId") ?? "");
  const project = choice ? await scopeProject(scope, choice) : null;
  if (choice && !project) return;
  await db.insert(schema.assignments).values({ memberId: member.id, fromM, toM, projectId: project?.id ?? null });
  refresh();
}

export async function saveClient(formData: FormData) {
  const scope = await getScope();
  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  const details = String(formData.get("details") ?? "").trim().slice(0, 1000);
  if (!name) return;
  const existing = await scopeClient(scope, formData.get("clientId"));
  if (existing) await db.update(schema.clients).set({ name, details }).where(eq(schema.clients.id, existing.id));
  else await db.insert(schema.clients).values({ orgId: scope.org.id, ownerMemberId: scope.ownerMemberId, name, details });
  refresh();
}

export async function deleteClient(formData: FormData) {
  const scope = await getScope();
  const client = await scopeClient(scope, formData.get("clientId"));
  if (!client) return;
  await db.delete(schema.clients).where(eq(schema.clients.id, client.id));
  refresh();
}

export async function createInvoice(_prev: FormState, formData: FormData): Promise<FormState> {
  const scope = await getScope();
  const client = await scopeClient(scope, formData.get("clientId"));
  let from = String(formData.get("from") ?? "");
  let to = String(formData.get("to") ?? "");
  if (!client) return { error: "Choose a client." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return { error: "Choose both dates." };
  if (to < from) [from, to] = [to, from];
  const { lines, skippedMinutes } = await draftLines(scope, client.id, from, to);
  if (lines.length === 0) {
    return {
      error: skippedMinutes
        ? "All the time for this client in those dates is already on another invoice."
        : "There is no sorted time for this client's projects in those dates. Give the client a project first, or sort the time on the Projects page.",
    };
  }
  const all = await scopeInvoices(scope);
  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      orgId: scope.org.id,
      ownerMemberId: scope.ownerMemberId,
      clientId: client.id,
      number: Math.max(0, ...all.map((i) => i.number)) + 1,
      fromDay: from,
      toDay: to,
      issuedOn: dayOfMinute(Math.floor(Date.now() / 60_000), scope.org.timezone),
      lines,
      totalCents: lines.reduce((n, l) => n + l.amountCents, 0),
    })
    .returning();
  refresh();
  redirect(`${scope.base}/invoices/${invoice.id}`);
}

export async function updateInvoice(formData: FormData) {
  const scope = await getScope();
  const invoice = await scopeInvoice(scope, formData.get("invoiceId"));
  if (!invoice || invoice.status !== "draft") return;
  const lines = invoice.lines.map((l, i) => {
    const hours = Number(formData.get(`hours-${i}`));
    const minutes = Number.isFinite(hours) && hours >= 0 ? Math.min(Math.round(hours * 60), 100_000) : l.minutes;
    const rateCents = cents(formData.get(`rate-${i}`));
    return {
      ...l,
      description: String(formData.get(`description-${i}`) ?? l.description).trim().slice(0, 200) || l.description,
      minutes,
      rateCents,
      amountCents: amount(minutes, rateCents),
    };
  });
  await db
    .update(schema.invoices)
    .set({ lines, totalCents: lines.reduce((n, l) => n + l.amountCents, 0), notes: String(formData.get("notes") ?? "").trim().slice(0, 1000) })
    .where(eq(schema.invoices.id, invoice.id));
  refresh();
}

export async function setInvoiceStatus(formData: FormData) {
  const scope = await getScope();
  const invoice = await scopeInvoice(scope, formData.get("invoiceId"));
  const status = String(formData.get("status"));
  if (!invoice || !["draft", "sent", "paid"].includes(status)) return;
  await db.update(schema.invoices).set({ status }).where(eq(schema.invoices.id, invoice.id));
  refresh();
}

export async function deleteInvoice(formData: FormData) {
  const scope = await getScope();
  const invoice = await scopeInvoice(scope, formData.get("invoiceId"));
  if (!invoice) return;
  await db.delete(schema.invoices).where(eq(schema.invoices.id, invoice.id));
  refresh();
  redirect(`${scope.base}/invoices`);
}

/** Adds the owner as a person on their own team, so their work is tracked too. */
export async function addMyself() {
  const { org, user } = await requireOwner();
  const [member] = await db.insert(schema.members).values({ orgId: org.id, name: user.name, email: user.email }).returning();
  await newInvite(member.id);
  revalidatePath("/settings");
}
