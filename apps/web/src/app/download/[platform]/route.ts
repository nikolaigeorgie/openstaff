const pick: Record<string, (name: string) => boolean> = {
  mac: (n) => n.endsWith(".dmg"),
  windows: (n) => n.endsWith("-setup.exe") || n.endsWith(".msi"),
};

interface Asset {
  id: number;
  name: string;
  browser_download_url: string;
}

/** Sends the visitor to the newest installer on GitHub Releases, including for a private repo. */
export async function GET(_req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const match = pick[platform];
  const repo = process.env.GITHUB_REPO;
  if (!match) return new Response("Unknown platform", { status: 404 });
  if (!repo) return new Response("Installers are not published yet.", { status: 503 });
  const token = process.env.GITHUB_TOKEN;
  const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const release = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "openstaff-web", ...auth },
    cache: "no-store",
  });
  if (!release.ok) return new Response("Installers are not published yet.", { status: 503 });
  const assets = ((await release.json()) as { assets: Asset[] }).assets ?? [];
  const asset = assets.find((a) => match(a.name));
  if (!asset) return new Response("No installer for this platform yet.", { status: 404 });
  if (!token) return Response.redirect(asset.browser_download_url, 302);
  // Private repo: ask GitHub for a short-lived signed link and pass that on.
  const signed = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`, {
    headers: { accept: "application/octet-stream", "user-agent": "openstaff-web", ...auth },
    redirect: "manual",
    cache: "no-store",
  });
  const location = signed.headers.get("location");
  if (!location) return new Response("Could not prepare the download.", { status: 502 });
  return Response.redirect(location, 302);
}
