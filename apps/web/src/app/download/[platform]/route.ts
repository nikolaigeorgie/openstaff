import { latestAssets, redirectTo } from "@/lib/releases";

const pick: Record<string, (name: string) => boolean> = {
  mac: (n) => n.endsWith(".dmg"),
  windows: (n) => n.endsWith("-setup.exe"),
};

/** Sends the visitor to the newest installer for their platform. */
export async function GET(_req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const match = pick[(await params).platform];
  if (!match) return new Response("Unknown platform", { status: 404 });
  const assets = await latestAssets();
  if (!assets) return new Response("Installers are not published yet.", { status: 503 });
  return redirectTo(assets.find((a) => match(a.name)));
}
