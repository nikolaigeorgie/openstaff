import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { deviceFromRequest } from "@/lib/auth";
import { todaySummary } from "@/lib/today";

/** Today's counted time for the tray app. Also serves as the tracker's "still here" check-in. */
export async function GET(req: Request) {
  const auth = await deviceFromRequest(req);
  if (!auth) return Response.json({ error: "Unknown device" }, { status: 401 });
  await db.update(schema.devices).set({ lastSeenAt: new Date() }).where(eq(schema.devices.id, auth.device.id));
  return Response.json(await todaySummary(auth.member, auth.org));
}
