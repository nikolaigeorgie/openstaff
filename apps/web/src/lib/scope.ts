import { and, asc, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { getSession, type Member, type Org } from "./auth";
import { activeMembers } from "./report";

/**
 * Whose projects, clients and invoices are in view.
 *  - company: the owner is signed in; everything that belongs to the company, everyone's time.
 *  - personal: one person, opened from their tray; their own private clients, their own time.
 */
export interface Scope {
  kind: "company" | "personal";
  org: Org;
  /** null for the company, the person's id for their private things. */
  ownerMemberId: string | null;
  /** People whose time is looked at. */
  members: Member[];
  /** Where the pages live: "" for the company, "/me" for a person. */
  base: string;
  /** Name printed as the sender of invoices. */
  sender: string;
}

export async function getScope(): Promise<Scope> {
  const s = await getSession();
  if (!s) redirect("/login");
  if (s.kind === "owner") {
    return { kind: "company", org: s.org, ownerMemberId: null, members: await activeMembers(s.org.id), base: "", sender: s.org.name };
  }
  return { kind: "personal", org: s.org, ownerMemberId: s.member.id, members: [s.member], base: "/me", sender: s.member.name };
}

const owned = <T extends { orgId: unknown; ownerMemberId: unknown }>(t: T, scope: Scope) =>
  and(
    eq(t.orgId as never, scope.org.id),
    scope.ownerMemberId ? eq(t.ownerMemberId as never, scope.ownerMemberId) : isNull(t.ownerMemberId as never),
  );

export const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/.test(v);

export function scopeProjects(scope: Scope) {
  return db.select().from(schema.projects).where(owned(schema.projects, scope)).orderBy(asc(schema.projects.name));
}
export function scopeClients(scope: Scope) {
  return db.select().from(schema.clients).where(owned(schema.clients, scope)).orderBy(asc(schema.clients.name));
}
export async function scopeProject(scope: Scope, id: unknown) {
  if (!uuid(id)) return null;
  const [row] = await db.select().from(schema.projects).where(and(eq(schema.projects.id, id), owned(schema.projects, scope))).limit(1);
  return row ?? null;
}
export async function scopeClient(scope: Scope, id: unknown) {
  if (!uuid(id)) return null;
  const [row] = await db.select().from(schema.clients).where(and(eq(schema.clients.id, id), owned(schema.clients, scope))).limit(1);
  return row ?? null;
}
export async function scopeInvoice(scope: Scope, id: unknown) {
  if (!uuid(id)) return null;
  const [row] = await db.select().from(schema.invoices).where(and(eq(schema.invoices.id, id), owned(schema.invoices, scope))).limit(1);
  return row ?? null;
}
export function scopeInvoices(scope: Scope) {
  return db.select().from(schema.invoices).where(owned(schema.invoices, scope));
}

export const COLORS = ["#3b82f6", "#e0763a", "#a855f7", "#0ea5a4", "#e0498a", "#84a81d", "#d2a106", "#6366f1", "#ef5d4e", "#14a06b"];
