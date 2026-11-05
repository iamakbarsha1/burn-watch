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
