import { assetText, latestAssets } from "@/lib/releases";

interface Manifest {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, { url: string; signature: string }>;
}

function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** Tells the desktop app whether a newer version exists. 204 means it is up to date. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ target: string; arch: string; version: string }> },
) {
  const { target, arch, version } = await params;
  const upToDate = new Response(null, { status: 204 });
  const assets = await latestAssets();
  const manifestAsset = assets?.find((a) => a.name === "latest.json");
  if (!assets || !manifestAsset) return upToDate;
  const text = await assetText(manifestAsset);
  if (!text) return upToDate;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return upToDate;
  }
  const entry = manifest.platforms?.[`${target}-${arch}`];
  if (!entry || !newer(manifest.version, version)) return upToDate;
  // The update file is served through this site, so it also works while the repo is private.
  const name = decodeURIComponent(new URL(entry.url).pathname.split("/").pop() ?? "");
  if (!assets.some((a) => a.name === name)) return upToDate;
  const origin = process.env.PUBLIC_URL ?? new URL(req.url).origin;
  return Response.json({
    version: manifest.version,
    notes: manifest.notes ?? "",
    pub_date: manifest.pub_date,
    url: `${origin}/download/asset/${encodeURIComponent(name)}`,
    signature: entry.signature,
  });
}
