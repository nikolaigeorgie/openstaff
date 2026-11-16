import { deviceFromRequest } from "@/lib/auth";
import { todaySummary } from "@/lib/today";

export async function GET(req: Request) {
  const auth = await deviceFromRequest(req);
  if (!auth) return Response.json({ error: "Unknown device" }, { status: 401 });
  return Response.json(await todaySummary(auth.member, auth.org));
}
