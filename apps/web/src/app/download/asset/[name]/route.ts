import { latestAssets, redirectTo } from "@/lib/releases";

/** A file from the newest release by name. Used by the desktop app's updater. */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const assets = await latestAssets();
  if (!assets) return new Response("Not published yet.", { status: 503 });
  return redirectTo(assets.find((a) => a.name === name));
}
