// Fills a local dev database with a demo team and a few days of made-up activity,
// sent through the real ingest API. Usage: pnpm exec tsx scripts/seed-dev.mts [baseUrl]
import postgres from "postgres";
import { hashPassword, randomToken, sha256 } from "../src/lib/crypto";

const base = process.argv[2] ?? "http://localhost:3000";
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const tz = "America/New_York";

const [org] = await sql`insert into orgs (name, timezone, period_anchor) values ('Demo Co', ${tz}, '2026-11-02') returning id`;
await sql`insert into users (org_id, email, name, password_hash) values (${org.id}, 'demo@example.com', 'Demo Owner', ${await hashPassword("demo-password")})`;

const people = [
  { name: "Ania", rate: 3500, style: "strong" },
  { name: "Marco", rate: 2800, style: "normal" },
  { name: "Jiggly Joe", rate: 2500, style: "weak" },
] as const;

const nowM = Math.floor(Date.now() / 60_000);
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

for (const p of people) {
  const [member] = await sql`insert into members (org_id, name, hourly_rate_cents) values (${org.id}, ${p.name}, ${p.rate}) returning id`;
  const token = randomToken();
  await sql`insert into devices (member_id, token_hash, platform, hostname, app_version) values (${member.id}, ${sha256(token)}, 'macos', ${p.name + "s-MacBook"}, '0.1.0')`;

  const minutes: object[] = [];
  const claude: object[] = [];
  const commits: object[] = [];
  for (let back = 4; back >= 0; back--) {
    // A working day ending "now" for today, or a 9 hour block for earlier days.
    const end = nowM - back * 1440;
    const start = end - 9 * 60;
    let m = start;
    while (m < end) {
      const work = 20 + Math.floor(rnd() * 70);
      const session = `s-${p.name}-${back}-${m}`;
      for (let i = 0; i < work && m < end; i++, m++) {
        const typing = p.style !== "weak" && rnd() < 0.7;
        minutes.push({
          m,
          keys: typing ? Math.floor(rnd() * 180) : 0,
          clicks: p.style === "weak" ? 0 : Math.floor(rnd() * 12),
          moves: Math.floor(rnd() * 200) + (p.style === "weak" ? 20 : 0),
          app: p.style === "weak" ? "Safari" : rnd() < 0.6 ? "Code" : rnd() < 0.5 ? "Google Chrome" : "Terminal",
          domain: p.style === "weak" ? "youtube.com" : rnd() < 0.3 ? "claude.ai" : rnd() < 0.5 ? "github.com" : null,
          paused: false,
        });
        if (p.style === "strong" && rnd() < 0.5) {
          claude.push({ m, sessionId: session, project: rnd() < 0.7 ? "storefront" : "billing-api", model: "claude-opus", prompts: rnd() < 0.3 ? 1 : 0, tokens: Math.floor(rnd() * 40_000) });
        }
        if (p.style !== "weak" && rnd() < 0.012) {
          commits.push({ sha: sha256(`${p.name}${m}`).slice(0, 40), repo: "storefront", m, added: Math.floor(rnd() * 200), removed: Math.floor(rnd() * 60), subject: "Tidy checkout flow" });
        }
      }
      // Then a break: tracker keeps reporting idle minutes for a while, then nothing.
      const gap = 5 + Math.floor(rnd() * 40);
      for (let i = 0; i < gap && m < end; i++, m++) {
        if (i < 20) minutes.push({ m, keys: 0, clicks: 0, moves: 0, app: "Code", domain: null, paused: back === 1 && i < 12 });
      }
    }
  }
  const res = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ appVersion: "0.1.0", minutes, claude, commits }),
  });
  console.log(p.name, res.status, JSON.stringify(await res.json()));
  if (p.name === "Ania") {
    const again = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ minutes, claude, commits }),
    });
    console.log("  resend (should not change totals)", JSON.stringify((await again.json()).today));
    const link = await fetch(`${base}/api/me/link`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    console.log("  self-view link", (await link.json()).url);
  }
}
const bad = await fetch(`${base}/api/ingest`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
console.log("bad token ->", bad.status);
await sql.end();
