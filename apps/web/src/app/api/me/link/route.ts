import { db, schema } from "@/db";
import { deviceFromRequest } from "@/lib/auth";
import { randomToken, sha256 } from "@/lib/crypto";

/** Gives the desktop app a one-time link that opens this person's own page in their browser. */
export async function POST(req: Request) {
  const auth = await deviceFromRequest(req);
  if (!auth) return Response.json({ error: "Unknown device" }, { status: 401 });
  const code = randomToken(24);
  await db.insert(schema.viewCodes).values({
    codeHash: sha256(code),
    memberId: auth.member.id,
    expiresAt: new Date(Date.now() + 2 * 60_000),
  });
  const origin = process.env.PUBLIC_URL ?? new URL(req.url).origin;
  return Response.json({ url: `${origin}/me/open?code=${code}` });
}
