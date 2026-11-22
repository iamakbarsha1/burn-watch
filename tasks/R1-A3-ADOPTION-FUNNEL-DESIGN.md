# R1 · A3 Adoption funnel per team: design

Status: built 2026-11-22 as web-v0.8.0 (decisions in "Decisions").
Roadmap: `tasks/ROLLOUT-ROADMAP.md` R1. Second section of `/adoption`, after
A1 idle seats (`tasks/R1-A1-IDLE-SEATS-DESIGN.md`). Uses R0.2 teams and the
same role rules as A1, B1, B2 and B3.

## Goal

Show, per team, how many people reached each step: invited, registered, first
sync, active, power user. An admin sees where people stall (no account,
account but no usage, used once and stopped) and which teams lag. With A1 this
closes the "R1 done when" line for the Adoption page. R2 uses the same funnel
to track agent v0.4 rollout, and D6 builds on "weekly active".

## What exists today

Every stage has data already. A3 is one new read, no new engine.

| Stage | Source | Notes |
|---|---|---|
| Invited | `invites` (`InviteDoc`: `email`, `teamId?`, `expiresAt`, `usedAt`) | Email is lowercased on create. No `userId` link; accept sets `usedAt` and creates the user. `teamId` set by R0.5 CSV invites (`email,role,team`), absent on older ones. |
| Registered | `users` (`createdAt`, `isActive`) | Accept also inserts a `teamMembers` row for the invite's team, if the team still exists. The first admin and seeded users have no invite. |
| (Device linked) | `devices.userId` | Not a roadmap stage, but the main gap between registered and first sync. `devices` has no index; the collection is tiny. |
| First sync | `dailySnapshots` with `totalTokens > 0` | Earliest such `date` per user. Can predate `createdAt` (history imported from Neon). |
| Weekly / power | `dailySnapshots` in the last 7 days | Days with tokens and token sum per user. `dailySnapshots_org_date` covers `orgId + date`. |

Pieces to reuse:

- `readScope(user, teamId)` and `comparableTeams(user)` in
  `apps/api/src/plugins/jwt.ts`: scope and team names, as A1 does.
- `adminUsersPipeline(orgId)` in `apps/api/src/routes/auth/device.ts` already
  joins `devices` (count) and `dailySnapshots` (last sync, active days) per
  user. Close, but all-time only, admin only, returns emails and caps at 500.
  A3 copies its two `$lookup`s rather than calling it.
- `apps/api/src/routes/dashboard/adoption.ts`: add the route here.

## What the data says today

One read-only query against prod, 2026-11-22 (UTC), 1 org:

- `invites`: 2 total, 2 used, 0 expired, 0 open. 0 carry a team.
- `users`: 6, all `isActive`, created 2026-11-05 to 2026-11-10. Only 2 match
  an invite email; 4 were created without one.
- Users with a device: 4 (7 devices).
- Users with any usage (tokens > 0): 2. First sync dates 2026-03-17 and
  2026-05-20, last 2026-11-18 and 2026-11-20.
- Active on 1+ days in 2026-11-16..2026-11-22: 2, on 2 days and 4 days.
  Token sums 539M and 43M.
- `teams`: 0. All 6 users are in no team.

Funnel today (org): invited 6 → registered 6 → device 4 → first sync 2 →
weekly active 2 → power user 1 (with "4+ of 7 days").

What this shows:

1. **Invite rows alone undercount "invited".** 4 of 6 users never had an
   invite. "Invited" has to mean "registered users plus people with an unused
   invite", so each stage stays a subset of the one before.
2. **Per-team rows are empty in prod until teams exist.** The org total and a
   "No team" row carry the section until admins create R0.2 teams.
3. **The big drop is device → first sync** (4 → 2). Showing "device linked"
   as a sub-line tells an admin whether to chase setup or usage.
4. **Percentile cuts mean nothing at 2 active people.** A day-count rule for
   power user gives a stable answer at any org size.

## Scope

In:
- `GET /adoption/funnel?teamId`: stage counts for the org (or the viewer's
  teams) and per team, as of today.
- "Funnel" section on `/adoption` below Idle seats: one row per team plus a
  total row, count and % of the previous stage per cell.
- Device linked as a secondary count under first sync, not a full stage.

Out (named, not built):
- Trends over time (funnel by week). Needs a stored series; later item.
- Per-person lists, unless Decision 5 says otherwise.
- Nudges or emails to people stuck at a stage. Waits on the notification channel.
- Time-to-stage (days from invite to first sync). Easy to add later from the
  same data.

## Data

No new collection, no index, no migration. Reads `invites`, `users`,
`devices`, `dailySnapshots`, `teams`, `teamMembers`.

Person set for a scope:

- Users in the org with `isActive: true`, filtered by scope.
- Plus unused invites (`usedAt: null`, open or expired) whose email matches no
  user in the org, deduped by email. Placed in a team by `invite.teamId`
  (Decision 3). In manager scope, only invites for a team they manage.

Per user, one aggregate on `users` (`$match` org and ids), mirroring
`adminUsersPipeline`:

- `$lookup devices` → `hasDevice`.
- `$lookup dailySnapshots` with `totalTokens > 0` → `firstSync` (`$min date`),
  `activeDays7` and `tokens7` (`$filter` to `date >= today - 6`).

Stage tests per person, each implying the one before:
`registered` = is a user; `firstSync` = `firstSync != null`;
`weeklyActive` = `activeDays7 >= 1`; `powerUser` = `activeDays7 >= 4`
(Decision 1). The logic is plain code over the rows, so it gets unit tests.

## API

`GET /adoption/funnel` in `adoption.ts`. Admin org-wide, manager own teams via
`readScope`, developer 403, 404 on a team the viewer cannot see. Query
`from`, `to`, `teamId?` (schema `FunnelQuerySchema` in
`packages/shared/src/schemas.ts`, reusing `dateRangeFields` and
`teamIdField`). Activity stages read `dailySnapshots` in the range.

```ts
interface FunnelCounts {
  invited: number; registered: number; deviceLinked: number
  firstSync: number; active: number; powerUser: number
}
type FunnelStop = 'invited' | 'registered' | 'firstSync' | 'active'
interface StuckPerson {
  stoppedAt: FunnelStop        // last stage reached
  userId: string | null        // null for an unused invite
  name: string | null; email: string | null   // invite email when no user
  teams: string[]; lastStepDate: IsoDate
}
interface FunnelResponse {
  from: IsoDate; to: IsoDate; rangeDays: number
  activeDays: number; powerDays: number   // thresholds in use (Decision 2)
  total: FunnelCounts                     // each person once, even in 2 teams
  teams: ({ teamId: string; teamName: string } & FunnelCounts)[]  // by name
  noTeam: FunnelCounts | null             // admins only; null for managers
  stuck: StuckPerson[]                    // same scope as the counts (Decision 5)
}
```

A person in two teams counts in both team rows and once in `total`. Read only:
no transaction, no audit event. Types in `packages/shared/src/types.ts`.

## Dashboard

- `adoption/page.tsx`: add `fetchFunnel(team?.id)` next to `fetchIdleSeats`,
  run both in parallel. Same team picker.
- Add `/adoption` to `RANGE_SCOPED` in `components/RangeBar.tsx`.
- "Funnel" section: a line under the table names the thresholds in use
  ("active = tokens on 2+ days; power user = 22+ of 30 days").
- Table: Team, Invited, Registered, First sync, Active, Power user.
  Cells show the count and % of the previous stage. First sync cell adds
  "4 linked a device" in muted text. Total row first, then teams, then "No
  team" (admins).
- Total row gets a plain CSS bar per stage. No chart library.
- "Who is stuck": a collapsed `<details>` per stopping point with name (or
  invite email), team and last-step date.
- Empty states: "No teams yet. Create them in Admin > Teams." under the total
  row when the org has 0 teams; "Could not read the funnel." on fetch error.

## Tests

- API: developer 403, manager sees own teams only and `noTeam` null, foreign
  `teamId` 404, another org's users and invites never count, inactive user
  left out, unused invite counted once per email and placed by `teamId`,
  pre-R0.5 invite in "No team", used invite never double counts its user,
  person in two teams counts once in `total`.
- Stage logic: fixed date, day 7 boundary (today - 6 in, today - 7 out),
  zero-token snapshot ignored, first sync before `createdAt` still counts,
  power user at exactly 4 days.
- Pipeline check in `apps/api/src/scripts/dashboard-pipelines.ts` next to
  `adminUsers`.
- Dashboard: % math with a zero previous stage shows "—", no-teams empty
  state, section hidden for developers (page already redirects).

## Release

Web feature: web-v0.8.0, CHANGELOG, tag `web-v0.8.0` with `--latest=false`.
No prod schema sync: no collection or index added.

## Decisions (2026-11-22)

1. **Active and power user:** stricter than proposed. Active means tokens on
   2 or more days; power user means tokens on 5 of every 7 days. The stage
   is called "Active", not "Weekly active", because of Decision 2.
2. **Window:** the page's date range, the same `from`/`to` the rest of the
   dashboard uses (`resolveRange`). `/adoption` joins `RANGE_SCOPED` in
   `RangeBar` so the picker shows there. The thresholds scale with the range
   length, so a 7-day range gives exactly Decision 1:
   - active: active days ≥ `min(2, rangeDays)`
   - power: active days ≥ `ceil(rangeDays × 5 / 7)`
   The range start is clamped to the org's first usage day when the picked
   `from` is earlier (decided 2026-11-22 after build), so "All time" from
   2020-01-01 does not set power at ~1,800 days. The response `from` is the
   clamped start.
   For a 30-day range that is 2+ days active and 22+ days power. A 1-day
   range makes both stages "used that day". The page states the two numbers
   in use under the table. (Scaling rule chosen to reconcile the two
   answers; not asked.) The A1 idle list keeps its own `idleDays` and
   ignores the range.
3. **Unregistered invitees and teams:** team from `invite.teamId`, else "No
   team". (Default taken, not asked.)
4. **Who sees it:** same as A1. Admins see the org, managers their own
   teams, developers get 403. (Default taken, not asked.)
5. **Drill-down:** counts plus who is stuck. Under the table, a list per
   stopping point: invited but not registered (invite email, sent date),
   registered but no first sync, synced but not active in range, active but
   not power. Each entry shows name (or invite email), team and the date of
   their last step. Same scoping as the counts, so a manager only sees their
   own teams' people. Collapsed by default. The API returns it in the same
   response as the counts.

Defaults taken, not asked: inactive users are left out; "device linked" is a
sub-line, not a stage; a user created without an invite counts as invited.

## Steps

1. Shared types and `FunnelQuerySchema`.
2. Stage logic + per-user pipeline, unit tests, pipeline check.
3. API route in `adoption.ts`, tests.
4. Dashboard section, `fetchFunnel`, tests.
5. Typecheck + tests, PR, CI.
6. Merge, release web-v0.8.0, smoke test (expect total row, "No team" row,
   no-teams note in prod).
7. Roadmap: A3 done, CHANGELOG.
