/** Reads installers and update files from the project's GitHub Releases, including a private repo. */

export interface Asset {
  id: number;
  name: string;
  browser_download_url: string;
}

function headers(accept: string): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return { accept, "user-agent": "openstaff-web", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

export async function latestAssets(): Promise<Asset[] | null> {
  const repo = process.env.GITHUB_REPO;
  if (!repo) return null;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: headers("application/vnd.github+json"),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return ((await res.json()) as { assets?: Asset[] }).assets ?? [];
}

/** A link the visitor's browser (or the app's updater) can download from directly. */
export async function downloadUrl(asset: Asset): Promise<string | null> {
  if (!process.env.GITHUB_TOKEN) return asset.browser_download_url;
  // Private repo: GitHub answers with a short-lived signed link, which is passed on.
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/releases/assets/${asset.id}`, {
    headers: headers("application/octet-stream"),
    redirect: "manual",
    cache: "no-store",
  });
  return res.headers.get("location");
}

export async function assetText(asset: Asset): Promise<string | null> {
  const url = await downloadUrl(asset);
  if (!url) return null;
  const res = await fetch(url, { cache: "no-store" });
  return res.ok ? res.text() : null;
}

export async function redirectTo(asset: Asset | undefined): Promise<Response> {
  if (!asset) return new Response("No installer for this platform yet.", { status: 404 });
  const url = await downloadUrl(asset);
  return url ? Response.redirect(url, 302) : new Response("Could not prepare the download.", { status: 502 });
}
