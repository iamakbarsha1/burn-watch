# Dashboard: range persistence, chart fix, perceived latency, Tailwind rewrite

## Root causes found (traced, not guessed)

1. **Range resets on every nav.** `DateRangePicker` writes `?from&to` to the URL, but
   the sidebar `<Link href="/users">` in `(dashboard)/layout.tsx` carries no query
   string, so the next page falls back to its own default. Defaults also disagree:
   Overview/Leaderboard/Activity/Projects default to *today*, Trends defaults to
   *last 30 days*.
2. **The blue "Claude" line is Gemini.** `BurnAreaChart` stacks the areas and gives
   each one a stroke. A series with ~zero spend still draws its stroke at the
   *cumulative* top, so Gemini ($0.64 total, last in paint order) traces Claude's
   curve in blue and hides it. Secondary: the API returns only dates that have rows,
   so an all-time x-axis renders a 6-month gap the same width as one day.
3. **Navigation feels dead.** No `loading.tsx` anywhere, so Next.js holds the old
   page until the whole server render finishes. Measured: API `/health` alone is
   0.5–2.2s, and every page fetch is `cache: 'no-store'`.
4. **Range selection feels dead.** Same cause, plus `router.push` with no
   `useTransition`, so the clicked button gives no feedback.
5. **UI is 100% inline `style={{}}`** — which cannot express hover, focus, active or
   responsive states. Tailwind v4 is installed and imported but entirely unused.
   Also `--foreground` / `--background` are referenced but never defined.

## Decisions (confirmed with user)

- Full Tailwind rewrite, every page, tokens in `@theme`.
- Chart: stacked areas (fills carry identity) **plus** a small-multiples row so the
  small agents are legible at their own scale.
- Fill date gaps so the x-axis is real calendar time.
- Palette validated with the dataviz checker against the real dark card surface
  `#111111` — all five checks PASS. Claude stays orange.

## Tasks

- [ ] `globals.css` — Tailwind v4 `@theme` design tokens, dark surface scale
- [ ] `lib/range.ts` — one `resolveRange()`, default **all time**, shared by all pages
- [ ] `lib/agents.ts` — validated agent palette + `fillDateGaps()`
- [ ] `components/ui.tsx` — Card / StatTile / Table / Badge / Button primitives
- [ ] `components/SidebarNav.tsx` — client nav, carries range forward, marks active
- [ ] `components/DateRangePicker.tsx` — `useTransition`, pending state, real tokens
- [ ] `(dashboard)/layout.tsx` — app shell, one filter row above all content
- [ ] `(dashboard)/loading.tsx` — skeleton so nav paints instantly
- [ ] `charts/BurnAreaChart.tsx` — stacked + small multiples, gap fill, tooltip
- [ ] `charts/AgentBreakdown.tsx`
- [ ] Pages: overview, users, trends, activity, projects, devices, setup, admin
- [ ] Auth: login, signup
- [ ] Verify: typecheck, tests, real browser pass on every page

## Review

All five items done, verified in a browser against real production data
(org `Akbar Corp`, $3,038.53 all time).

**The one that was not in the list.** Tailwind was never wired up. `tailwindcss`
and `@tailwindcss/postcss` were both in package.json and `@import "tailwindcss"`
was at the top of globals.css, but no `postcss.config.*` existed anywhere in the
repo — so the import compiled to nothing and no utility class had ever done
anything. That is almost certainly why every component was written with inline
`style` objects in the first place. Typecheck, 198 unit tests and `next build`
all passed on a completely unstyled app; only opening a browser showed it.

**Also found and fixed, unreported:** the Overview "Active users" tile read 63
for an org with four people. `count(dailySnapshots.userId)` counts snapshot
rows, and `daily_snapshots` holds one row per user per day — so one developer
with 63 days of history reported 63 developers. Now `countDistinct`, confirmed
against the database (63 rows, 1 real user) and covered by a falsified test.

### How each reported item was resolved

1. **Range persistence.** `resolveRange()` in `lib/format.ts` is now the single
   place a page turns `?from&to` into a range, defaulting to all time. The
   sidebar became a client component that forwards the current query string, so
   the range survives a nav; it lives in the URL, so it survives a refresh and
   stays shareable. The picker moved out of the five page headers into one
   filter row in the layout, which hides itself on the three pages a date range
   means nothing to.
2. **Claude line.** The areas are stacked and each carried a stroke in its own
   colour; a near-zero series still draws that stroke at the *cumulative* top,
   so Gemini (64 cents, painted last) traced Claude's curve in blue. Identity
   now lives in the fill and the stroke is the card colour, which doubles as the
   2px gap between bands. Gaps in the date series are filled with zero days, so
   the all-time x-axis is real calendar time instead of rendering a six-month
   gap as one tick. Palette re-validated against the real card surface.
3. **Page nav lag.** There was no `loading.tsx` anywhere, so Next held the old
   page until the server render finished — measured 0.5–2.2s on the API alone.
   Added a skeleton matching the real layout, plus a per-link spinner via
   `useLinkStatus`.
4. **Range selection lag.** `router.push` now runs inside `useTransition`, so
   the pressed button reports immediately and the existing numbers hold instead
   of flashing.
5. **UI.** Full Tailwind rewrite, all 13 pages and 5 components, on `@theme`
   tokens. Real hover/focus/active states, active-nav marker, responsive
   sidebar→strip below `md`, shared `ui.tsx` primitives, grouped thousands on
   every figure.

### Verification

- `npm run typecheck` — 5/5 clean
- `npm test` — 198 passing (shared 26, agent 27, dashboard 24, api 121)
- `next build` — clean, 13 routes
- Browser pass at 1440px and 390px on every page, signed in against the real API
- Both new test groups falsified (reverted the fix, watched them fail, restored)

---

## BW-39 · Cross-platform setup — 2026-11-10

### What changed

1. **Windows could never collect.** `CcusageCollector` spawned `npx` with no
   shell. On Windows that is `npx.cmd`, which a bare spawn fails `ENOENT` on;
   the collector logged and returned null, so `collect` returned an empty
   array and a Windows machine would have reported zero every evening with no
   error anywhere a user looks. One option — `shell: process.platform ===
   'win32'` — fixes it, and two tests faking `process.platform` pin it.
2. **`/setup` is now per-OS.** Body moved into `components/SetupSteps.tsx`
   behind a macOS/Linux/Windows switch that defaults to the reader's own OS.
   Four steps differ: installing Bun, building and placing the binary, the
   config path, and verifying the schedule. Troubleshooting branches too.
3. **The Linux instruction was wrong, not just missing.** Both documents told
   Linux users to hand-write a crontab line, which has double-scheduled the
   sync since BW-20 installed a systemd timer. Gone. `loginctl enable-linger`
   is documented now, which the systemd backend has quietly needed all along.
4. **Windows now exists in the docs.** PowerShell build, the `$HOME\bin` PATH
   line nothing else sets, `schtasks /query /tn BurnWatchSync`, and a
   `command not found` troubleshooting row.
5. **`docs/INSTALL.md`, `setup.md`, `docs/ARCHITECTURE.md`** all carry the
   three-backend story, plus a cross-compile table so one machine can build
   every binary.

### Verification

- `npm run typecheck` — 5/5 clean
- `npm test` — agent 58, dashboard 48, 5/5 tasks green
- `next build` — clean, 13 routes
- Browser pass at 1440px and 390px on all three OS tabs, signed in against
  the real API
- Both new test groups falsified (removed the fix, watched them fail,
  restored)

### Still open

- BW-20's debt is unchanged: nobody has watched a systemd timer or a Task
  Scheduler task actually fire. Both documents now say so where a developer
  who could settle it will read it.

---

## BW-40 · Prebuilt binaries and a one-line install — 2026-11-10

### What changed

1. **Release `v0.2.0`** publishes four binaries and `checksums.txt`. A stale
   `v0.1.0` from 2026-06-24 was already there — three binaries, no checksums,
   built before BW-31 fixed a default API URL that pointed at a domain which
   never existed, so `register` on it could only fail. Its `darwin-x64` asset
   had been downloaded, so a new tag was cut rather than the old one rewritten.
2. **`scripts/install.sh` rewritten.** It already existed and had never run:
   it resolved the latest tag through the GitHub API, then downloaded from a
   release that did not exist. It verified nothing, and defaulted to
   `/usr/local/bin` with a `sudo` fallback — a password prompt inside a piped
   shell. Now: checksum-gated, `~/.local/bin`, no sudo, no API call, warns
   when an older hand-installed copy still wins the PATH lookup.
3. **`scripts/install.ps1`** for Windows, same checksum gate.
4. **One version constant.** It was three literals, and the one that matters
   is `agentVersion` in `register` — the `devices` table stores whatever it is
   told. `src/version.ts` plus a test against `package.json`.
5. **`/setup` drops to five steps.** Build-from-source moved into a native
   `<details>`.

### Verification

- `npm run typecheck` — 5/5 clean
- `npm test` — 376 passing (shared 36, agent 60, api 232, dashboard 48)
- Install tested end to end through the real raw.githubusercontent URL:
  downloaded, checksum verified, `--version` → `0.2.0`, self-check OK, PATH
  warning fired
- Refusal paths tested, both exit 1 and install nothing: a release with no
  `checksums.txt` (real, against `v0.1.0`), and a tampered binary
- Version drift test falsified
- Dashboard deployed to production and `/setup` confirmed live

### Also closed

- **BW-08.** Signed in at the real deployment and loaded all eight pages;
  every one returned production data. The two boxes had been open since
  2026-11-05 recorded as "nobody has credentials" — credentials were created
  the next day and the blocker was never rechecked.

### Still open

- `install.ps1` is reviewed, not executed. No PowerShell on this machine to
  even parse it. Same debt as BW-20.
- BW-20 itself: nobody has watched a systemd timer or a Task Scheduler task
  fire.
- `apps/api/.env.example` still ships `REDIS_URL`, `CORS_ORIGIN` and
  `COPILOT_ENCRYPTION_KEY`. Nothing reads them. The path is behind a deny
  rule, so it needs a human: `sed -i '' '/^REDIS_URL=/d; /^CORS_ORIGIN=/d;
  /^COPILOT_ENCRYPTION_KEY=/d' apps/api/.env.example`
