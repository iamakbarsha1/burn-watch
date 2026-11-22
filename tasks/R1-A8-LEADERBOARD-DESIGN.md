# R1 · A8 Leaderboard by active days, streaks, features tried: design

Status: decisions made 2026-11-22 (see "Decisions"), ready to build. Ship
target web-v0.9.0. Where earlier sections disagree with Decisions, Decisions win.
Roadmap: `tasks/ROLLOUT-ROADMAP.md` R1. Reworks the existing Leaderboard
(`/users`), not a new page. Uses the same role rules as A1, A3, B1, B2 and B3.
D1 (AI Wrapped, R4) builds on the streaks defined here.

## Goal

Rank people by how often they use AI tools, not by how much they spend. The
table shows active days in the range, current and longest streak, and how many
agents and MCP servers each person has tried. Dollar columns are hidden until
the viewer asks for them. This closes the last part of "R1 done when": the
leaderboard no longer ranks by dollars. Features tried gets richer in R2, once
agent v0.4 fields arrive.

## What exists today

The leaderboard is already a ranked, paged, range-scoped table. A8 changes
what it ranks by and what it shows.

| Piece | Where | Today |
|---|---|---|
| Route | `GET /v1/dashboard/leaderboard` in `apps/api/src/routes/dashboard/leaderboard.ts` | `from`/`to` (or `date`), `limit` 1..200 (default 100), `offset`. No `teamId`. |
| Pipeline | `leaderboardPipeline(orgId, from, to, limit, offset, userIds?)` | `$facet` on `dailySnapshots`: `users` (sums cost, tokens, sessions; sort `totalCostMicros: -1, _id: 1`; skip/limit in DB), `agents` (per user and agent from `byAgent`), `everyone` (integrity check: throws if a snapshot user has no user doc). |
| Scope | `viewerScope(request.user)` | Admin: org. Manager: self plus members of managed teams. Developer: own row only. |
| Cost | Every row | `totalCostUsd` (value), `actualCostUsd` (seats + API), `apiSpendUsd`, `valueMultiple`, per-agent `costUsd`. All shown on the page. |
| Page | `apps/dashboard/src/app/(dashboard)/users/page.tsx` | "Developer Leaderboard ... ranked by API-equivalent value". Columns: Claude $, Qwen tokens, Copilot $, Value, Actual cost, Multiple, Sessions, Cache hit (always empty: the API sends `cacheHitRate: null`). No team picker. |
| Range | `resolveRange` + `RangeBar` | `/users` is already in `RANGE_SCOPED`. |
| Nav | `SidebarNav.tsx` | "Leaderboard" shown to every role. |
| Checks | `apps/api/src/scripts/dashboard-pipelines.ts` (`leaderboard`), `apps/api/src/routes/routes.test.ts` | Several checks assert "ranks by spend". They change with the sort. |

Data for the new columns:

- **Active day:** a `dailySnapshots` row with `totalTokens > 0`. Same rule as
  A1 and A3. `date` is a UTC day: the agent collector buckets events by
  `timestamp.slice(0, 10)`.
- **Agents tried:** keys of `dailySnapshots.byAgent` with `tokens > 0`. The
  `agents` facet branch already groups these per user.
- **Models used:** `dailySnapshots.modelsUsed`. Available, but noisy (see below).
- **MCP servers and built-in tools:** `claudeEnrichment.mcpUsage` and
  `.toolUsage` (Claude only). `toolUsageTotals` in `activity.ts` sums them per
  org; A8 needs distinct keys per user instead.
- **Waits on R2 (agent v0.4):** `skillCounts` (skills), `sidechainMessages`
  (subagents), `permissionModeCounts` (plan mode), `entrypointCounts` (CLI vs
  SDK), `claudeVersions`. All null on days synced by an older agent.
- **Sync timing:** the agent's daily schedule runs at 18:00 local and syncs
  yesterday by default. So today is never in the data, and before 18:00 local
  yesterday is not either.

## What the data says today

One read-only query against prod, 2026-11-22 (a Sunday, UTC), 1 org:

- `users`: 6. With any usage: 2 (User A, User B). 118 active user-days,
  81 `claudeEnrichment` docs.
- Active days, last 7 / last 30 / all time: A 4 / 20 / 68, B 2 / 15 / 50.
- Last active day: A 2026-11-20 (Fri), B 2026-11-18 (Wed).
- Streaks, every calendar day counts: A longest 18, ending run 4; B longest 6,
  ending run 1.
- Streaks, weekends skipped: A longest 32, ending run 4; B longest 13, ending
  run 1. A has 14 weekend active days, B has 1.
- Agents ever: A 5 (claude, codex, qwen, copilot, gemini), B 2. In the last
  30 days: 1 each.
- Models ever: A 19, B 3 (last 30 days: 9 and 1).
- MCP servers ever: A 10, B 6. Built-in tools: A 24, B 17. Shell commands:
  A 422, B 109.
- v0.4 fields (skills, subagents, plan mode, entrypoint): 0 days with data.

What this shows:

1. **Weekends decide streak length.** Skipping weekends roughly doubles both
   longest streaks. A rule that breaks on weekends rewards weekend work, which
   is the wrong signal for a team tool.
2. **"Current streak" depends on the sync lag.** On a Sunday, A's last active
   day is Friday. Without a grace rule A shows 0, though nothing was missed.
3. **Model counts measure release churn, not curiosity.** A's 19 models are
   mostly versions of the same few. Shell command counts are worse. Agents and
   MCP servers are the honest "features tried" today.
4. **"Features tried" will look thin until R2.** 0 days carry v0.4 fields, so
   skills, subagents and plan mode cannot be shown yet.
5. **At 2 active people a ranking is mostly a list.** The table must still
   read well when everyone ties, and must not single out the one person at
   the bottom.

## Scope

In:
- Sortable ranking (Decision 1): `?sort=activeDays|score|streak|tokens|cost`,
  default `activeDays`. Rank follows the sort. Paging stays in the DB.
- A 0-100 "Score" column, one of the sort options (Decision 1).
- New columns: active days ("12 of 30"), current streak, longest streak,
  agents tried, MCP servers tried. Tokens and sessions stay.
- Cost columns hidden by default; a "Show cost" toggle via `?cost=1` for
  every role (Decision 5).
- Visibility settings (Decision 4): org `developerView` and `showNames` on
  Admin, and a per-person "Hide my name on the leaderboard".
- `teamId` filter via `readScope`, and the `TeamFilter` picker on the page,
  as on Overview, Trends and Adoption.
- Title "Leaderboard", subtitle "ranked by active days".

Out (named, not built):
- Skills, subagents, plan mode, CLI vs SDK in features tried. R2, A5.
- Badges, streak notifications, or "you are #3" nudges. Wait on a channel.
- Per-person history page or streak calendar. D1 territory.
- Holiday or leave calendars for streaks.
- View logging. Belongs to B8 (Decision 7).
- Manager-level visibility override (offered, not chosen).

## Data

No new collection, no index, no migration. Two optional fields, no
validator on either collection, so no prod schema sync (Decision 4):
`OrganizationDoc.leaderboard?: { developerView: 'own' | 'rank' | 'full';
showNames: boolean; showOthersCost: boolean }` (absent = `own`, `true`,
`false`), and
`UserDoc.hideOnLeaderboard?: boolean`. Reads `dailySnapshots`,
`claudeEnrichment`, `users`, `seats`, `teams`, `teamMembers`.
`dailySnapshots_org_date` covers the range match.

Changes to `leaderboardPipeline`:

- `users` branch `$group` adds
  `activeDays: { $sum: { $cond: [{ $gt: ['$totalTokens', 0] }, 1, 0] } }`.
  Sort becomes `{ activeDays: -1, totalTokens: -1, _id: 1 }` (Decision 1).
  Users with 0 active days in range (zero-token rows only) drop out.
- `agents` branch is unchanged. Agents tried = keys with `tokens > 0`.

Two more reads, for the page's user ids only:

- **Streaks:** `dailySnapshots.find({ orgId, userId: { $in: page }, totalTokens: { $gt: 0 } }, { projection: { userId: 1, date: 1 } })`.
  All time, not range-bound (Decision 3). At most one row per user-day.
- **MCP servers:** `claudeEnrichment` aggregate in range,
  `$objectToArray: '$mcpUsage'`, `$group` by user with `$addToSet` of keys.
  Built the same way as `toolUsageTotals`, exported for the pipeline check.

Streak rule, one pure function `streaks(dates, today)` in
`apps/api/src/routes/dashboard/streaks.ts`, so D1 reuses it:

- A streak is a run of active days where no weekday in between is missing.
  Saturday and Sunday never break a streak; activity on them still counts
  (Decision 2).
- `today` and `today - 1` (UTC) never break the current streak. Data for them
  is usually not synced yet.
- `current` = the run that reaches the latest day allowed by the rule above,
  else 0. `longest` = the longest run ever. `lastActive` = latest active date.
- Days are UTC dates, as stored. A user far from UTC can see a late session
  land on the next day (or on a Saturday). Accepted; it matches every other
  page.

## API

`GET /leaderboard` keeps its path, query and array response. New query field
`teamId` (`teamIdField`); `readScope` replaces `viewerScope`, with
`scopeError` on 403/404. Developers still get only their own row. Cost fields
stay in the response for rows the viewer may see cost on; other rows get
`null` cost fields per Decision 5. The show/hide toggle is a page concern.

```ts
interface Streak {
  current: number              // days in the live run, 0 if broken
  longest: number              // longest run, all time
  lastActive: IsoDate | null
}
interface FeaturesTried {
  agents: AgentName[]          // byAgent keys with tokens > 0, in range
  mcpServers: string[]         // mcpUsage keys, in range, sorted
}
interface LeaderboardEntry {
  // existing fields unchanged: userId, name, email, per-agent
  // { tokens, costUsd }, totalCostUsd, totalTokens, sessions, cacheHitRate,
  // actualCostUsd, apiSpendUsd, valueMultiple
  rank: number                 // shared on ties (1, 2, 2, 4)
  activeDays: number           // in range
  streak: Streak
  features: FeaturesTried
}
```

Names rather than counts in `features`, so the page can show them in a
tooltip and R2 can add `skills`, `subagents` and `planMode` without a shape
change. Read only: no transaction, no audit event. Types in
`packages/shared/src/types.ts`.

## Dashboard

- `users/page.tsx`: pass `teamId` and read `?cost`. Add `TeamFilter` like
  `adoption/page.tsx`. `fetchLeaderboard` gains `teamId?`.
- Default columns: #, Developer, Active days ("12 of 30", range length from
  `from`/`to`), Streak (current, with "best 18" muted below), Agents (count,
  names on hover), MCP servers (count, names on hover), Tokens, Sessions.
- With `?cost=1`: add Value, Actual cost, Multiple, and the per-agent `$`
  under the token figures. The "Show cost" / "Hide cost" link sits in the
  header and keeps the range in the URL. Shown per Decision 5.
- Drop the Cache hit column. It has been empty since the Mongo move.
- A line under the table: "Active day = any tokens that day (UTC). Weekends
  do not break a streak. Today and yesterday may not be synced yet."
- Empty state stays "No data for this range"; fetch error shows "Could not
  read the leaderboard."
- `lib/transparency.ts`: `enrichment.mcpUsage` comment adds "Leaderboard".
  No audience change; the field is already `scoped`.

## Tests

- `streaks`: weekday gap breaks; Sat/Sun gap does not; weekend activity adds
  to the run; last active `today - 1` and `today - 2` (Fri seen on Sun) keep
  `current`; a missed weekday before that sets `current` 0; empty input
  gives 0/0/null; unsorted and duplicate dates; month and year ends.
- Pipeline (`dashboard-pipelines.ts`): rewrite the "ranks by spend" checks to
  "ranks by active days"; tie on days falls back to tokens then `_id`;
  zero-token days do not count; paging stays stable across ties; MCP
  pipeline returns distinct keys per user and ignores other orgs.
- Route (`routes.test.ts`): developer sees own row; manager sees managed
  teams; foreign `teamId` 404, unmanaged team 403; cost fields still present;
  `rank` shared on ties; another org's snapshots never count.
- Page: cost columns absent by default; present with `?cost=1` for the roles
  in Decision 5; toggle link hidden for others; "12 of 30" math; team picker
  keeps the range.

## Release

Web feature: web-v0.9.0, CHANGELOG, tag `web-v0.9.0` with `--latest=false`.
No prod schema sync. Prod will show two rows, A above B.

## Decisions (2026-11-22)

1. **Ranking:** both sortable columns and a score. Every metric is a column;
   `?sort=` picks the ranking: `activeDays` (default), `score`, `streak`
   (current), `tokens`, `cost`. Rank follows the sort, ties share a rank and
   fall back to tokens then `_id`. Score is 0-100: each of active days,
   current streak, tokens and features tried is scaled against the top
   person in the same scope and range, then weighted 40 / 30 / 20 / 10.
   Cost is not in the score, so spend never lifts a rank unless someone
   sorts by cost. Weights are a constant, named on the page under the table.
   (Weights are a default taken, not asked.) Sorting by `streak` or `score`
   needs streaks for every row in scope, not only the page: the streak read
   covers all users in scope, which is fine at org size; note the limit in a
   `shortcut:` comment.
2. **Weekends:** a Saturday or Sunday gap never breaks a streak; weekend
   activity still counts. Today and yesterday never break the current streak.
3. **Streak window:** all time, ignoring the range picker. Active days,
   tokens, score and features follow the range. (Default taken, not asked.)
4. **Visibility, three levels of settings:**
   - Org `developerView` (Admin page): `own` (today: own row only), `rank`
     (own row plus "#3 of 12", no other people), or `full` (the whole list in
     their scope's org). Default `own`.
   - Org `showNames` (Admin page): off shows everyone as "Person 1, 2..."
     (stable by rank) to managers and developers. Admins always see names.
     Default on.
   - Per person `hideOnLeaderboard` (own profile/settings): shows as
     "Anonymous" to everyone except admins and themselves. Default off.
   Admins see the org, managers their own teams, as today. Hiding a name
   never removes the row or changes rank, so counts stay honest.
   Changing an org setting is an admin write and gets the same audit
   treatment as other admin settings once B8 lands.
5. **Cost toggle:** every role. Cost is hidden by default; "Show cost"
   (`?cost=1`) works for everyone. Admins see cost for every row in the
   org, managers for their teams. Developers see cost on their own row
   only, even in `full` mode, unless the admin turns on the third org
   setting `showOthersCost` (Admin page, default off). The API enforces
   this: for a developer viewer without `showOthersCost`, other rows come
   back with every cost field (`totalCostUsd`, `actualCostUsd`,
   `apiSpendUsd`, `valueMultiple`, per-agent `costUsd`) set to `null`, and
   `sort=cost` falls back to `activeDays`. (Decided 2026-11-22, supersedes
   "cost on every visible row".)
6. **Features tried now:** agents and MCP servers only. Not models or shell
   commands. R2 adds skills, subagents and plan mode. (Default taken.)
7. **Audit logging:** none in A8 for views; B8 covers per-person views.
   (Default taken.)
8. **Bottom of the list:** full list, no "lowest" highlight. (Default taken.)

## Steps

1. Shared types (`Streak`, `FeaturesTried`, new `LeaderboardEntry` fields
   incl. `score`), `teamId`, `sort` and `cost` in the query schema; the two
   optional doc fields.
2. `streaks.ts` with unit tests.
3. Pipeline: `activeDays` and new sort, MCP-per-user pipeline, streak read;
   update the pipeline checks.
4. Route: `readScope`, `sort`, `rank`, `score`, `developerView`,
   `showNames`, `hideOnLeaderboard` masking; route tests per mode.
4b. Settings: org leaderboard settings on Admin, "Hide my name" for each
   user; API writes, tests.
5. Page: columns, cost toggle, team picker, footnote; `fetchLeaderboard`;
   page tests; transparency comment.
6. Typecheck + tests, PR, CI.
7. Merge, release web-v0.9.0, smoke test `/users` in prod (A then B, cost
   hidden, toggle shows cost).
8. Roadmap: A8 done, CHANGELOG.
