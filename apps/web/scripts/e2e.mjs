// Drives the real pages as an owner and plays the desktop app over the real API.
// Creates throwaway accounts, so point it at a local copy only.
// Usage: pnpm --filter @openstaff/web e2e [baseUrl]   (needs Google Chrome and GITHUB_REPO set for the server)
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:3111";
const shots = new URL("../.e2e-shots/", import.meta.url).pathname;
mkdirSync(shots, { recursive: true });
const stamp = Date.now();
const owner = { company: "Acme Studio", name: "Dana Owner", email: `owner-${stamp}@example.com`, password: `pw-${stamp}-x` };

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});
async function newPage(ctx) {
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on("pageerror", (e) => check(`no page error (${e.message.slice(0, 80)})`, false));
  return page;
}
const go = (page, path) => page.goto(base + path, { waitUntil: "networkidle0" });
const text = (page) => page.evaluate(() => document.body.innerText);
const shot = (page, name) => page.screenshot({ path: `${shots}${name}.png`, fullPage: true });
/** Click a button and wait for the server action and re-render to finish. */
async function act(page, fn) {
  await fn();
  await new Promise((r) => setTimeout(r, 300));
  await page.waitForNetworkIdle({ idleTime: 600 }).catch(() => {});
}
async function clickText(page, selector, label, nth = 0) {
  const handles = await page.$$(selector);
  const hits = [];
  for (const h of handles) if ((await h.evaluate((e) => e.innerText.trim())) === label) hits.push(h);
  if (!hits[nth]) throw new Error(`No ${selector} "${label}" #${nth}`);
  await act(page, () => hits[nth].click());
}
const api = async (path, { token, body, method } = {}) => {
  const res = await fetch(base + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  return { status: res.status, json: await res.json().catch(() => null), res };
};

const ctxOwner = await browser.createBrowserContext();
const page = await newPage(ctxOwner);

// 1. Signed out
await go(page, "/team");
check("signed out: /team sends to login", page.url().includes("/login"));
await go(page, "/");
await shot(page, "01-home");

// 2. Sign up
await go(page, "/signup");
await page.type("#company", owner.company);
await page.type("#name", owner.name);
await page.type("#email", owner.email);
await page.type("#password", owner.password);
await shot(page, "02-signup");
await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("button.btn")]);
check("signup lands on settings", page.url().includes("/settings"), page.url());
check("welcome text shown", (await text(page)).includes("Welcome"));

// 3. Add people
async function addPerson(name, rate) {
  await page.type("#new-name", name);
  await page.type("#new-rate", rate);
  await clickText(page, "button", "Add person");
}
await addPerson("Ania", "40");
await addPerson("Marco", "25.50");
let body = await text(page);
check("both people listed", (await page.$$eval('input[name="name"][id^="name-"]', (els) => els.map((e) => e.value))).sort().join() === "Ania,Marco");
check("add form cleared after adding", (await page.$eval("#new-name", (e) => e.value)) === "", await page.$eval("#new-name", (e) => e.value));
const links = () => page.$$eval("code", (els) => els.map((e) => e.innerText).filter((t) => t.includes("/join/")));
let invites = await links();
eq("two invite links", invites.length, 2);
check("invite link uses this site", invites.every((l) => l.startsWith(base)), invites[0]);
check("email invite link offered", (await page.$$eval('a[href^="mailto:"]', (a) => a.length)) === 2);
await shot(page, "03-settings-people");

// Which link is whose
async function inviteFor(name) {
  return page.evaluate((name) => {
    for (const card of document.querySelectorAll(".card")) {
      const input = card.querySelector('input[id^="name-"]');
      if (input?.value === name) {
        const code = [...card.querySelectorAll("code")].find((c) => c.innerText.includes("/join/"));
        return { link: code?.innerText ?? null, memberId: card.querySelector('input[name="memberId"]').value };
      }
    }
    return null;
  }, name);
}
const ania = await inviteFor("Ania");
const marco = await inviteFor("Marco");

// 4. Employee opens the invite
const ctxEmp = await browser.createBrowserContext();
const emp = await newPage(ctxEmp);
await emp.goto(ania.link, { waitUntil: "networkidle0" });
body = await text(emp);
check("join page greets Ania", body.includes("Hi Ania") && body.includes(owner.company));
const aniaCode = ania.link.split("/join/")[1];
check("join page shows the code", body.includes(aniaCode));
await shot(emp, "04-join");
for (const p of ["mac", "windows"]) {
  const r = await fetch(`${base}/download/${p}`, { redirect: "manual" });
  check(`download ${p} redirects to a file`, r.status === 302 || r.status === 307, `${r.status} ${r.headers.get("location") ?? ""}`.slice(0, 120));
}

// 5. The app claims the code
const claim = (code, extra = {}) => api("/api/devices/claim", { body: { code, platform: "macos", hostname: "Anias-MacBook", appVersion: "0.1.0", ...extra } });
const c1 = await claim(aniaCode.toLowerCase());
check("claim works (lower-case code too)", c1.status === 200 && c1.json.member === "Ania" && c1.json.org === owner.company, JSON.stringify(c1.json).slice(0, 80));
const aniaToken = c1.json?.token;
eq("code cannot be used twice", (await claim(aniaCode)).status, 404);
eq("made-up code refused", (await claim("ZZZZZZZZ")).status, 404);
await emp.reload({ waitUntil: "networkidle0" });
check("used invite page says so", (await text(emp)).includes("no longer valid"));

// 6. Second computer for the same person
await go(page, "/settings");
check("settings shows connected computer", (await text(page)).includes("Anias-MacBook"));
await clickText(page, "button", "Invite another computer");
const ania2 = await inviteFor("Ania");
check("new invite link issued", !!ania2.link && ania2.link !== ania.link);
const c2 = await claim(ania2.link.split("/join/")[1], { platform: "windows", hostname: "ANIA-PC" });
eq("second computer joins", c2.status, 200);
const aniaToken2 = c2.json?.token;
const c3 = await claim(marco.link.split("/join/")[1], { hostname: "Marcos-MacBook" });
const marcoToken = c3.json?.token;
eq("Marco joins", c3.status, 200);

// 7. A day of work. Ends one minute ago.
const nowM = Math.floor(Date.now() / 60_000);
function aniaDay() {
  const minutes = [], claude = [], commits = [];
  let m = nowM - 151;
  for (let i = 0; i < 60; i++, m++) minutes.push({ m, keys: 120, clicks: 8, moves: 40, app: "Code", domain: null });
  for (let i = 0; i < 30; i++, m++) minutes.push({ m, keys: 0, clicks: 0, moves: 0, app: "Code", domain: null });
  minutes.push({ m, keys: 60, clicks: 2, moves: 5, app: "Terminal", domain: null });
  claude.push({ m, sessionId: "sess-1", project: "acme-api", model: "claude-fable-5-2", prompts: 1, tokens: 1200 });
  m++;
  for (let i = 0; i < 20; i++, m++) {
    minutes.push({ m, keys: 0, clicks: 0, moves: 0, app: "Terminal", domain: null });
    claude.push({ m, sessionId: "sess-1", project: "acme-api", model: "claude-fable-5-2", prompts: 0, tokens: 5000 });
  }
  for (let i = 0; i < 10; i++, m++) minutes.push({ m, keys: 200, clicks: 9, moves: 30, app: "Messages", domain: null, paused: true });
  for (let i = 0; i < 30; i++, m++) minutes.push({ m, keys: 90, clicks: 12, moves: 30, app: "Google Chrome", domain: "github.com" });
  commits.push({ sha: stamp.toString(16).padStart(12, "0") + "abcdef0123", repo: "acme-api", m: m - 1, added: 42, removed: 7, subject: "Add invoice export" });
  return { appVersion: "0.1.0", minutes, claude, commits };
}
const EXPECT_ANIA = 60 + 5 + 1 + 15 + 30; // typing, grace, prompt minute, waiting on Claude, typing
const day1 = aniaDay();
const i1 = await api("/api/ingest", { token: aniaToken, body: day1 });
check("upload accepted", i1.status === 200 && i1.json.accepted.minutes === 151, JSON.stringify(i1.json?.accepted));
eq("tray number after upload", i1.json?.today?.verifiedMinutes, EXPECT_ANIA);
const i2 = await api("/api/ingest", { token: aniaToken, body: day1 });
eq("same upload again changes nothing", i2.json?.today?.verifiedMinutes, EXPECT_ANIA);
eq("upload with a bad token refused", (await api("/api/ingest", { token: "nope", body: day1 })).status, 401);
eq("upload with no token refused", (await api("/api/ingest", { body: day1 })).status, 401);
eq("malformed upload refused", (await api("/api/ingest", { token: aniaToken, body: { minutes: [{ m: "x" }] } })).status, 400);
const future = await api("/api/ingest", { token: aniaToken, body: { minutes: [{ m: nowM + 600, keys: 9, clicks: 0, moves: 0 }] } });
eq("minutes from the future dropped", future.json?.accepted?.minutes, 0);
// Second computer overlapping the same minutes must not double count.
const overlap = day1.minutes.slice(0, 30).map((r) => ({ ...r, app: "Excel" }));
const i3 = await api("/api/ingest", { token: aniaToken2, body: { minutes: overlap } });
eq("two computers at once are not double counted", i3.json?.today?.verifiedMinutes, EXPECT_ANIA);
// Marco: 40 minutes of mouse movement only.
const marcoMinutes = Array.from({ length: 40 }, (_, i) => ({ m: nowM - 41 + i, keys: 0, clicks: 0, moves: 55, app: "VLC", domain: null }));
const i4 = await api("/api/ingest", { token: marcoToken, body: { minutes: marcoMinutes } });
eq("Marco mouse-only minutes counted", i4.json?.today?.verifiedMinutes, 40);
const t1 = await api("/api/me/today", { token: aniaToken });
eq("tray check-in matches", t1.json?.verifiedMinutes, EXPECT_ANIA);

// 8. Team page
await go(page, "/team");
body = await text(page);
check("team: Ania 1h 51m", /Ania[\s\S]*1h 51m/.test(body));
check("team: Marco thin evidence flagged", /thin evidence/.test(body));
check("team: 2 people, total 2h 31m", body.includes("of 2 working now") && body.includes("2h 31m counted today"), body.match(/.*working now.*/)?.[0]);
await shot(page, "05-team");

// 9. Person page + time added by hand
await go(page, `/people/${ania.memberId}`);
body = await text(page);
check("person: counted 1h 51m", /Counted time\s+1h 51m/.test(body), body.match(/Counted time\s+\S+ \S+/)?.[0]);
check("person: Claude prompt, project, commit shown", body.includes("acme-api") && body.includes("Add invoice export"));
check("person: apps and site shown", body.includes("Code") && body.includes("github.com"));
check("person: paused app not listed as work", !/Messages\s+0h/.test(body) && !body.includes("Messages"), "Messages listed");
await page.type("#hours", "1.5");
await page.type("#note", "Client call");
await clickText(page, "button", "Add time");
body = await text(page);
check("person: 1h 30m added by hand", /Counted time\s+3h 21m/.test(body) && body.includes("Client call"), body.match(/Counted time\s+\S+ \S+/)?.[0]);
await shot(page, "06-person-ania");
await go(page, `/people/${marco.memberId}`);
check("person: Marco warned as mouse only", (await text(page)).includes("mouse movement only"));
await shot(page, "07-person-marco");
await clickText(page, "a", "← Previous day");
check("person: empty earlier day", (await text(page)).includes("Nothing recorded on this day"));

// 10. Payroll
await go(page, "/payroll");
body = await text(page);
check("payroll: Ania 3h 21m at $40 = $134.00", body.includes("$134.00") && body.includes("3h 21m"));
check("payroll: Marco 0h 40m at $25.50 = $17.00", body.includes("$17.00"));
check("payroll: total $151.00", /Total to pay\s+\$151\.00/.test(body), body.match(/Total to pay\s+\S+/)?.[0]);
await shot(page, "08-payroll");
const csv = await page.evaluate(async () => {
  const r = await fetch(document.querySelector('a[href^="/payroll/export"]').href);
  return { status: r.status, type: r.headers.get("content-type"), name: r.headers.get("content-disposition"), text: await r.text() };
});
const csvRows = csv.text.trim().split("\r\n").map((l) => l.split(","));
const aniaRow = csvRows.find((r) => r[0] === "Ania") ?? [];
check("csv: Ania 1.85 tracked, 1.50 by hand, 3.35 to pay, 134.00", aniaRow.slice(-6).join() === "1.85,0.00,1.50,3.35,40.00,134.00", aniaRow.slice(-6).join());
check("csv: is a named csv file", csv.type?.includes("text/csv") && /payroll-.*\.csv/.test(csv.name ?? ""), csv.name);
eq("csv: 14 day columns", csvRows[0].length, 1 + 14 + 6);
eq("csv refused when signed out", (await fetch(`${base}/payroll/export`)).status, 401);

// Lock, then more work arrives: locked numbers must not move.
await clickText(page, "button", "Lock period");
check("payroll: locked", (await text(page)).includes("locked"));
const more = Array.from({ length: 1 }, () => ({ m: nowM, keys: 50, clicks: 1, moves: 1, app: "Code", domain: null }));
await api("/api/ingest", { token: aniaToken, body: { minutes: more } });
await go(page, "/payroll");
check("payroll: locked total unchanged after new work", /Total to pay\s+\$151\.00/.test(await text(page)));
await clickText(page, "button", "Unlock");
body = await text(page);
check("payroll: unlocked total picks up new work", !/Total to pay\s+\$151\.00/.test(body), body.match(/Total to pay\s+\S+/)?.[0]);
await clickText(page, "a", "← Earlier");
check("payroll: earlier period is empty and has a way back", (await text(page)).includes("Later →") && /Total to pay\s+\$0\.00/.test(await text(page)));

// 11. Employee's own page, from the tray
const link = await api("/api/me/link", { token: aniaToken, method: "POST" });
check("tray gives a one-time link", link.status === 200 && link.json.url.startsWith(base), link.json?.url?.slice(0, 60));
await emp.goto(link.json.url, { waitUntil: "networkidle0" });
body = await text(emp);
check("employee sees own page", emp.url().endsWith("/me") && body.includes("Ania") && body.includes("exactly what"));
check("employee sees the same counted time as the owner", /Counted time\s+3h 2[12]m/.test(body), body.match(/Counted time\s+\S+ \S+/)?.[0]);
check("employee cannot add or remove time", !body.includes("Add time") && !body.includes("Remove"));
await shot(emp, "09-employee-me");
for (const path of ["/team", "/payroll", "/settings", `/people/${marco.memberId}`]) {
  await emp.goto(base + path, { waitUntil: "networkidle0" });
  check(`employee blocked from ${path.replace(marco.memberId, "<other person>")}`, emp.url().endsWith("/me"), emp.url());
}
const ctxAnon = await browser.createBrowserContext();
const anon = await newPage(ctxAnon);
await anon.goto(link.json.url, { waitUntil: "networkidle0" });
check("one-time link cannot be reused", anon.url().includes("/login"), anon.url());

// 12. Another company cannot see this one
const ctxOther = await browser.createBrowserContext();
const other = await newPage(ctxOther);
await go(other, "/signup");
await other.type("#company", "Rival Inc");
await other.type("#name", "Rex Rival");
await other.type("#email", `rival-${stamp}@example.com`);
await other.type("#password", owner.password);
await Promise.all([other.waitForNavigation({ waitUntil: "networkidle0" }), other.click("button.btn")]);
const r404 = await other.goto(`${base}/people/${ania.memberId}`, { waitUntil: "networkidle0" });
eq("other company gets 404 on our person", r404.status(), 404);
await go(other, "/team");
check("other company sees an empty team", (await text(other)).includes("Add your first person"));
await go(other, "/signup");
await ctxOther.deleteCookie(...(await ctxOther.cookies()));
await go(other, "/signup");
await other.type("#company", "Dupe");
await other.type("#name", "Dupe");
await other.type("#email", owner.email.toUpperCase());
await other.type("#password", "whatever-123");
await act(other, () => other.click("button.btn"));
check("same email cannot sign up twice", (await text(other)).includes("already an account"));

// 13. Editing, disconnecting, removing
await go(page, "/settings");
const rateSel = `#rate-${ania.memberId}`;
await page.$eval(rateSel, (e) => { e.value = ""; });
await page.type(rateSel, "50");
await act(page, () => page.$eval(rateSel, (e) => e.closest("form").querySelector("button").click()));
check("save shows Saved", (await page.$eval(rateSel, (e) => e.closest("form").querySelector("button").innerText)).includes("Saved"));

await go(page, "/payroll");
check("rate change shows in payroll", (await text(page)).includes("$50.00/h"));
await go(page, "/settings");
await clickText(page, "button", "Disconnect", 0);
check("disconnect asks first", (await text(page)).includes("Click again to disconnect"));
await clickText(page, "button", "Click again to disconnect", 0);
const afterRevoke = [await api("/api/me/today", { token: aniaToken }), await api("/api/me/today", { token: aniaToken2 })].map((r) => r.status).sort().join();
eq("disconnected computer is refused, the other still works", afterRevoke, "200,401");
await clickText(page, "button", "Remove from team", 1);
await go(page, "/settings");
check("one click does not remove", (await page.$$eval('input[id^="name-"]', (e) => e.length)) === 2);
await clickText(page, "button", "Remove from team", 1);
await clickText(page, "button", "Click again to remove Marco");
await go(page, "/team");
check("removed person leaves the team list", !(await text(page)).includes("Marco"));
eq("removed person's computer is refused", (await api("/api/me/today", { token: marcoToken })).status, 401);
await go(page, "/settings");
await page.$eval("#org-name", (e) => { e.value = ""; });
await page.type("#org-name", "Acme Studio LLC");
await act(page, () => page.$eval("#org-name", (e) => e.closest("form").requestSubmit()));
await go(page, "/team");
check("company rename shows in header", (await text(page)).includes("Acme Studio LLC"));

// 14. Phone width
await page.setViewport({ width: 390, height: 800, isMobile: true });
for (const [path, name] of [["/team", "10-phone-team"], [`/people/${ania.memberId}`, "11-phone-person"], ["/payroll", "12-phone-payroll"], ["/settings", "13-phone-settings"]]) {
  await go(page, path);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`phone: ${path.split("/")[1]} has no sideways page scroll`, overflow <= 0, `${overflow}px`);
  await shot(page, name);
}
await page.setViewport({ width: 1280, height: 900 });

// 15. Log out and back in
await go(page, "/team");
await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => /log out|sign out/i.test(b.innerText)).click();
})]);
check("log out goes to login", page.url().includes("/login"), page.url());
await go(page, "/team");
check("logged out: /team is closed", page.url().includes("/login"));
await page.type("#email", owner.email);
await page.type("#password", "wrong-password");
await act(page, () => page.click("button.btn"));
check("wrong password refused", (await text(page)).includes("Wrong email or password"));
check("email kept after wrong password", (await page.$eval("#email", (e) => e.value)) === owner.email);
await page.type("#password", owner.password);
await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("button.btn")]);
check("log in works", page.url().endsWith("/team"), page.url());

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
