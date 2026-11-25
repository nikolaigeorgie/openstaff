import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { deviceFromRequest } from "@/lib/auth";

const Body = z.object({
  suggestions: z
    .array(z.object({ field: z.enum(["repo", "url", "title", "site", "app"]), match: z.string().min(1).max(300), projectId: z.string().uuid() }))
    .max(100)
    .default([]),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  summary: z.string().max(1200).optional(),
});

/** Suggestions only: nothing is sorted until a person accepts it on the Projects page. */
export async function POST(req: Request) {
  const auth = await deviceFromRequest(req);
  if (!auth) return Response.json({ error: "Unknown device" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const ids = [...new Set(parsed.data.suggestions.map((s) => s.projectId))];
  const allowed = ids.length
    ? await db.select({ id: schema.projects.id, owner: schema.projects.ownerMemberId }).from(schema.projects).where(and(eq(schema.projects.orgId, auth.org.id), inArray(schema.projects.id, ids)))
    : [];
  const ok = new Set(allowed.filter((p) => p.owner === null || p.owner === auth.member.id).map((p) => p.id));
  const rows = parsed.data.suggestions.filter((s) => ok.has(s.projectId)).map((s) => ({ memberId: auth.member.id, ...s }));
  for (const row of rows) {
    await db
      .insert(schema.suggestions)
      .values(row)
      .onConflictDoUpdate({ target: [schema.suggestions.memberId, schema.suggestions.field, schema.suggestions.match], set: { projectId: row.projectId } });
  }
  if (parsed.data.day && parsed.data.summary?.trim()) {
    await db
      .insert(schema.daySummaries)
      .values({ memberId: auth.member.id, day: parsed.data.day, text: parsed.data.summary.trim() })
      .onConflictDoUpdate({ target: [schema.daySummaries.memberId, schema.daySummaries.day], set: { text: parsed.data.summary.trim() } });
  }
  return Response.json({ ok: true, accepted: rows.length });
}
