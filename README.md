# Open Staff

Verified work hours for teams that work on a computer, mostly with Claude.

Nobody clocks in. A small tray app starts with the computer, notices when work happens, and only
counts minutes backed by evidence. The person being tracked sees exactly the same numbers as the owner.

## How a minute gets counted

A minute counts when the tracker was running, not paused, and:

1. there was keyboard or mouse input in it, a Claude prompt, or a commit, or
2. it is within 5 minutes of the last input (reading, thinking), or
3. Claude is working on their prompt and it is within 15 minutes of the last input.

Everything else is idle and not counted. Hours with mouse movement only (no keys, clicks, Claude or
commits) are flagged as thin evidence. The rule lives in `packages/core/src/verify.ts` and is applied
on the server, so it can be tuned and re-applied to past data.

## What is recorded

| Recorded | Never recorded |
|---|---|
| Key press, click and mouse-move counts per minute | Which keys were pressed |
| Name of the app in front; site domain in a browser (Mac) | Screenshots, window titles, full web addresses, page contents |
| Claude Code usage: prompt times, project folder, model, tokens | Claude prompts, replies or code |
| The person's own commits: time, repository, size, subject line | Diffs or file contents |

Only activity after a computer joins a team is recorded. Paused time records nothing.

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
```

`OPENSTAFF_SERVER` at build time sets the server the desktop app reports to.

## Release

Push a tag such as `v0.1.0`. GitHub Actions builds the Mac and Windows installers and publishes a
release; the dashboard's download buttons and the app's auto-update read from the latest release.
The web app needs `GITHUB_REPO` (and `GITHUB_TOKEN` while the repo is private).
