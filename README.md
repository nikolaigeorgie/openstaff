# Open Staff

Verified work hours for teams that work on a computer, mostly with Claude.

Nobody clocks in. A small tray app starts with the computer, notices when work happens, and only
counts minutes backed by evidence. It also notes what the work was on, so time sorts itself into
projects and can be invoiced. The person being tracked sees the same numbers as the owner.

## How a minute gets counted

A minute counts when the tracker was running, not paused, and:

1. there was keyboard or mouse input in it, a Claude prompt, or a commit, or
2. it is within 5 minutes of the last input (reading, thinking), or
3. Claude is working on their prompt and it is within 15 minutes of the last input, or
4. they are on a call (the microphone has been in use for two minutes or more).

Everything else is idle and not counted. Hours with mouse movement only (no keys, clicks, Claude or
commits) are flagged as thin evidence, and so is a call that stays silent for over two hours. The rule lives in `packages/core/src/verify.ts` and is applied
on the server, so it can be tuned and re-applied to past data.

## How time gets a project

A project is a set of rules over what was in front during a minute. First match wins:

1. a correction made by hand,
2. the repository or folder (terminal, editor, Claude Code session, commit),
3. the page address, then the window title (a Slack channel, an admin panel, a document), then the
   site, then the app,
4. a detour of up to 10 minutes between two stretches of one project stays with that project.

Whatever is left shows up as Unsorted on the Projects page, grouped by what it was. Picking a project
for a group saves a rule, and because sorting runs on the server from raw minutes, past time is
re-sorted too. When several Claude sessions run at once, the minute is billed once, to the project in
front; the others are shown as Claude working alone. The rule lives in `packages/core/src/attribute.ts`.

Projects, clients and invoices exist twice: the company's (owner dashboard) and each person's own
(opened from the tray). Time on a person's own project is hidden from the company and left out of
company payroll.

## What is recorded

| Recorded | Never recorded |
|---|---|
| Key press, click and mouse-move counts per minute | Which keys were pressed |
| App and window title in front | Screenshots or anything drawn on the screen |
| In a browser: site and page path (Mac), without the query string | Page contents; anything in a private window |
| Folder or repository the front terminal is working in (Mac) | File contents |
| Whether the microphone is in use (to notice calls) | Sound |
| Claude Code usage: prompt times, project folder, model, tokens | Claude prompts, replies or code |
| The person's own commits: time, repository, size, subject line | Diffs or file contents |

Only activity after a computer joins a team is recorded. Paused time records nothing. Window titles
are not read for password managers, Messages, WhatsApp and similar apps (`is_sensitive_app` in
`apps/desktop/src-tauri/crates/sensors`). On macOS, titles need the Accessibility permission.

Optionally, and off by default, a person can let Claude Code on their own computer suggest projects
for unsorted time once a day and write a short summary of the day. It is given labels only and its
suggestions must be accepted by a person.

## Layout

- `packages/core`: the verified-hours rule and pay-period maths, with tests
- `apps/web`: owner dashboard, employee view and ingest API (Next.js, Drizzle, Postgres)
- `apps/desktop`: tray app for Mac and Windows (Tauri, Rust)

## Develop

```sh
pnpm install
pnpm test                                  # core rule tests

# web: needs DATABASE_URL in apps/web/.env.local
pnpm --filter @openstaff/web db:migrate
pnpm dev:web

# desktop: needs Rust (https://rustup.rs)
cd apps/desktop && pnpm tauri dev
cd apps/desktop/src-tauri && cargo test --workspace

# full walkthrough in a real browser against a local copy: sign up, add people, invite,
# connect computers, upload work, payroll, employee view, permissions (80 checks)
pnpm --filter @openstaff/web e2e http://localhost:3000
```

`OPENSTAFF_SERVER` at build time sets the server the desktop app reports to.

## Deploy

The web app runs on Vercel (project root `apps/web`) with a Neon Postgres database. `vercel deploy --prod`
from the repo root; migrations run during the build.

## Release

Push a tag such as `v0.1.0`. GitHub Actions builds the Mac and Windows installers and publishes a
release; the dashboard's download buttons and the app's auto-update read from the latest release.
The web app needs `GITHUB_REPO` (and `GITHUB_TOKEN` while the repo is private).
