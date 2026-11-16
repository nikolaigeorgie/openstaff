import { and, eq, gt } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { createSession } from "@/lib/auth";
import { sha256 } from "@/lib/crypto";

/** Trades a one-time code from the desktop app for a short browser session, then shows /me. */
export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get("code") ?? "";
  const [row] = await db
    .delete(schema.viewCodes)
    .where(and(eq(schema.viewCodes.codeHash, sha256(code)), gt(schema.viewCodes.expiresAt, new Date())))
    .returning();
  if (!row) redirect("/login?expired=1");
  await createSession({ memberId: row.memberId });
  redirect("/me");
}
