import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { deviceFromRequest } from "@/lib/auth";
import { todaySummary } from "@/lib/today";

const count = z.number().int().min(0).max(1_000_000);
const minute = z.number().int().positive();
/** Optional text, cut to length rather than refused: a long window title must not lose the minute. */
const clip = (max: number) => z.string().nullish().transform((s) => (s ? s.slice(0, max) : null));

const Body = z.object({
  appVersion: z.string().max(40).optional(),
  minutes: z
    .array(
      z.object({
        m: minute,
        keys: count,
        clicks: count,
        moves: count,
        app: z.string().max(120).nullish(),
        domain: z.string().max(253).nullish(),
        paused: z.boolean().default(false),
        title: clip(300),
        path: clip(300),
        repo: clip(200),
        call: z.boolean().default(false),
      }),
    )
    .max(5000)
    .default([]),
  claude: z
    .array(
      z.object({
        m: minute,
        sessionId: z.string().min(1).max(80),
        project: z.string().min(1).max(200),
        model: z.string().max(80).nullish(),
        prompts: count,
        tokens: z.number().int().min(0).max(2_000_000_000),
      }),
    )
    .max(5000)
    .default([]),
  commits: z
    .array(
      z.object({
        sha: z.string().regex(/^[0-9a-f]{7,64}$/),
        repo: z.string().min(1).max(200),
        m: minute,
        added: count,
        removed: count,
        subject: z.string().max(300).default(""),
      }),
    )
    .max(2000)
    .default([]),
});

const MAX_AGE_MINUTES = 60 * 24 * 60;

function lastWins<T>(items: T[], key: (t: T) => string): T[] {
  return [...new Map(items.map((i) => [key(i), i])).values()];
}

/** Batched upload from the desktop app. Safe to retry: every row is an upsert. */
export async function POST(req: Request) {
  const auth = await deviceFromRequest(req);
  if (!auth) return Response.json({ error: "Unknown device" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });

  const nowM = Math.floor(Date.now() / 60_000);
  // Nothing from the future, nothing ancient.
  const ok = (m: number) => m <= nowM + 2 && m >= nowM - MAX_AGE_MINUTES;
  const ids = { deviceId: auth.device.id, memberId: auth.member.id };

  const minutes = lastWins(parsed.data.minutes.filter((r) => ok(r.m)), (r) => String(r.m));
  const claude = lastWins(parsed.data.claude.filter((r) => ok(r.m)), (r) => `${r.m}:${r.sessionId}`);
  const commits = lastWins(parsed.data.commits.filter((r) => ok(r.m)), (r) => r.sha);

  for (let i = 0; i < minutes.length; i += 500) {
    await db
      .insert(schema.minutes)
      .values(minutes.slice(i, i + 500).map((r) => ({ ...ids, ...r })))
      .onConflictDoUpdate({
        target: [schema.minutes.deviceId, schema.minutes.m],
        set: {
          keys: sql`excluded.keys`,
          clicks: sql`excluded.clicks`,
          moves: sql`excluded.moves`,
          app: sql`excluded.app`,
          domain: sql`excluded.domain`,
          paused: sql`excluded.paused`,
          title: sql`excluded.title`,
          path: sql`excluded.path`,
          repo: sql`excluded.repo`,
          call: sql`excluded.call`,
        },
      });
  }
  for (let i = 0; i < claude.length; i += 500) {
    await db
      .insert(schema.claudeUsage)
      .values(claude.slice(i, i + 500).map((r) => ({ ...ids, ...r })))
      .onConflictDoUpdate({
        target: [schema.claudeUsage.deviceId, schema.claudeUsage.m, schema.claudeUsage.sessionId],
        set: {
          project: sql`excluded.project`,
          model: sql`excluded.model`,
          prompts: sql`excluded.prompts`,
          tokens: sql`excluded.tokens`,
        },
      });
  }
  for (let i = 0; i < commits.length; i += 500) {
    await db
      .insert(schema.commits)
      .values(commits.slice(i, i + 500).map((r) => ({ memberId: auth.member.id, ...r })))
      .onConflictDoNothing();
  }

  await db
    .update(schema.devices)
    .set({ lastSeenAt: new Date(), ...(parsed.data.appVersion ? { appVersion: parsed.data.appVersion } : {}) })
    .where(eq(schema.devices.id, auth.device.id));

  return Response.json({
    ok: true,
    accepted: { minutes: minutes.length, claude: claude.length, commits: commits.length },
    today: await todaySummary(auth.member, auth.org),
  });
}
