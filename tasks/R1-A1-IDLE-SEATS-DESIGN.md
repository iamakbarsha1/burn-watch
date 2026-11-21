# R1 · A1 Idle seats per agent: design

Status: built 2026-11-22, web-v0.7.0. Decisions made 2026-11-22 (see "Decisions"); built changes in "As built". Roadmap: `tasks/ROLLOUT-ROADMAP.md` R1.
Builds on R0.1 seats (`tasks/R0.1-SEATS-DESIGN.md`) and uses the same role rules as
B1, B2 and B3 (`tasks/R1-B2-AGENT-POLICY-DESIGN.md`).

## Goal

Show every paid seat nobody has used for 14+ days, per agent: who holds it, when
it was last used, how many days it has sat idle, and what it costs per month.
Admins see the org; managers see their teams. This is the list an admin cancels
seats from. It is the first section of the Adoption page the roadmap asks for
("R1 done when": an Adoption page with A1 and A3).

## What exists today

R0.1 already built most of the logic. A1 is a view on it, not a new engine.

| Piece | Where | What it does |
|---|---|---|
| `idleSeats(store, orgId, userId, agent, idleDays, date)` | `packages/db/src/seats.ts` | Seats with no tokens on their own agent in the last `idleDays` days, from `dailySnapshots.byAgent`. Skips seats younger than the window. Returns `SeatDoc[]`, no dates. |
| `seatCost(seat, from, to, today)` | same file | Prorated seat cost over a range (monthly × 12 ÷ 365 per day). |
| `idle-seat` budget alert | `budget-alert.service.ts` (`evaluateSeatAlerts`, `applyTrip`), `routes/dashboard/budget-alerts.ts` | Trips when any seat in its scope is idle. GET lists idle seats as `{ userId, userName, agent }`. |
| Alert UI | `admin/BudgetAlertsPanel.tsx` | "Idle seat" type with an idle-days field (default 14), tripped alerts list idle holders. |
| Seat list | `admin/SeatsPanel.tsx`, `GET /seats` | Admin-only list of seats with price and start date. No usage info. |
| Copilot roster | `GET /copilot/seats`, `admin/CopilotPanel.tsx` | Idle Copilot licences from GitHub's own `lastActivityAt` (`idleAfterDays`, default 30). Separate source, Copilot only. |

Gaps the alert leaves:

1. **No standing list.** The alert answers "is anything idle", one yes/no per
   alert. With no alert configured, nobody sees idle seats at all.
2. **No dates or money.** It names the holder and agent, not last used, days
   idle, or cost.
3. **Admin only, on `/admin`.** Managers never see their teams' idle seats.
4. **Trips on events.** `applyTrip` runs on usage submit, seat write and alert
   CRUD. A seat that goes idle by time alone shows as idle on the next GET of
   `/budget-alerts` (it recomputes live), but the stored `tripped` flag and the
   banner wait for the next event.

## What the data says today

One read-only query against prod, 2026-11-21 (UTC):

- `seats`: **0 documents.** No org has entered a seat yet.
- `users`: 6.
- Per-agent last use (from the B2 query, `usageEvents`): claude 2026-11-20,
  copilot 2026-07-10, gemini 2026-04-24, qwen 2026-04-14, codex 2026-03-18.

What this shows:

1. **A1 shows an empty list in prod until admins enter seats.** Org fact #1
   (plan tiers and per-seat price) is the real blocker for useful output, not
   code. The empty state must say so and link to Admin > Seats.
2. **Once seats exist, most non-Claude seats would show as idle.** Four of five
   agents have had no usage in 4+ months. The list must sort longest idle first
   and handle "never used" without breaking.

## Scope

In:
- `GET /adoption/idle-seats?teamId&idleDays`: idle seats in scope, one row per
  seat, with last used, days idle, monthly price and cost since last use.
- New `/adoption` page with an "Idle seats" section. A3 adds the funnel later.
- Nav item "Adoption" for admin and manager.
- A count of idle seats and their monthly total at the top of the section.

Out (named, not built):
- Push alerts. Waits on the notification channel, same as B2.
- Cancelling or editing seats from this page. Admins do that in Admin > Seats.
- Merging the Copilot GitHub roster into this list. Different source and
  threshold; a later item if both show the same seat.
- A scheduled job to trip `idle-seat` alerts without an event (gap 4). Note it,
  fix with the notification channel.
- History of idle periods. The list is always "as of today".

## Data

No new collection, no index, no migration. Reads `seats`, `dailySnapshots`,
`users`, `teams`, `teamMembers`.

One new helper in `packages/db/src/seats.ts`, next to `idleSeats`:

```ts
/** Last date each (user, agent) pair had tokens, as seat keys. Null = never. */
seatLastUsed(store, orgId, userIds): Promise<Map<SeatKey, IsoDate>>
```

Same shape as `activePairsPipeline` with no date bound and a
`$max: '$date'` in the `$group`. It runs on the idle seats' holders only,
filtered by `orgId` and `userId $in`, which `dailySnapshots_org_date` covers.

## API

New file `apps/api/src/routes/dashboard/adoption.ts`, registered in
`routes/dashboard/index.ts`.

`GET /adoption/idle-seats`: admin org-wide, manager own teams via
`readScope(request.user, teamId)`, developer 403, 404 on a team the viewer
cannot see. Query: `teamId?`, `idleDays?` (int 1 to 365, default per
Decision 2).

1. `idleSeats(store, orgId, null, null, idleDays, today())`, then keep seats
   whose `userId` is in scope (scope `undefined` means the whole org).
2. `seatLastUsed` for those holders.
3. Per row: `lastUsed` (or null), `idleSince` = day after `lastUsed`, or
   `startDate` if never used, `daysIdle` = today minus `idleSince` plus 1,
   `monthlyPriceUsd`, `costSinceUsedUsd` = `seatCost(seat, idleSince, today, today)`.
4. Names and teams with the same helpers B1 uses (`comparableTeams`, user
   lookup in the org).

Response:

```ts
{
  idleDays: number
  rows: IdleSeatRow[]      // userId, userName, teams, agent, startDate, lastUsed, daysIdle,
                           // monthlyPriceUsd, costSinceUsedUsd; sorted daysIdle desc
  byAgent: { agent: AgentName; seats: number; monthlyUsd: number }[]
  byTeam: { teamId: string; teamName: string; seats: number; monthlyUsd: number }[]
  totalMonthlyUsd: number
}
```

Types in `packages/shared/src/types.ts`; the query schema in `schemas.ts`.
Read only, so no transaction and no audit event.

## Dashboard

- `apps/dashboard/src/app/(dashboard)/adoption/page.tsx`: server page, same
  layout as `governance/page.tsx` (team picker, `Section`).
- "Idle seats" section: summary line ("4 idle seats, $160/month"), then a
  table: person, teams, agent, last used ("never" when null), days idle,
  $/month, cost since last use. Sorted longest idle first.
- Small per-agent totals row above the table.
- Empty states: "No seats entered yet. Add them in Admin > Seats." (admins,
  zero seats in org) and "No seats idle for N+ days." (seats exist).
- Nav: "Adoption" in `SidebarNav` for admin and manager, right after
  Governance (before "My data"). No count badge (Decision 5).

## Tests

- API: developer 403, manager sees own teams only, foreign `teamId` 404,
  another org's seat never shows, `idleDays` bounds 400, seat younger than the
  window skipped, never-used seat counts from `startDate`, `lastUsed` and
  `daysIdle` math on a fixed date, cost matches `seatCost`.
- `seatLastUsed`: max date per pair, ignores zero-token days and other agents.
  Add to `scripts/dashboard-pipelines.ts` next to the existing idle check.
- Dashboard: rows and sort, "never" label, both empty states, nav item hidden
  for developers.

## Release

Web feature: web-v0.7.0, CHANGELOG, tag `web-v0.7.0` with `--latest=false`.
No prod schema sync: no collection or index added.

## Decisions (2026-11-22)

0. **Build now,** even though prod has 0 seats. The page ships ready, and its
   empty state points admins to Admin > Seats. Seat prices are org fact #1.
1. **Where it lives:** a new `/adoption` page. The roadmap names it, and A3
   and A8 land there next.
2. **Idle threshold:** a `?idleDays` setting on the page, default 14, with a
   small number input. Nothing stored. It does not read any alert's
   `idleDays`, since an org can have several alerts with different values.
3. **Seat never used:** idle from `startDate`, and seats younger than the
   window are skipped, as `idleSeats` already does. Shown as "never".
   (Default taken, not asked.)
4. **Managers:** see their own teams' idle seats, with price. Same role rules
   as Governance; developers get 403.
5. **The idle-seat alert:** kept. A tripped idle-seat alert in
   `BudgetAlertsPanel` links to `/adoption`. No nav badge. (Default taken,
   not asked.)

## Steps

1. `seatLastUsed` helper and pipeline check.
2. Shared types and query schema.
3. API route `adoption.ts`, register, tests.
4. Dashboard `/adoption` page, nav item, alert link, tests.
5. Typecheck + tests, PR, CI.
6. Merge, release web-v0.7.0, smoke test (expect the empty state in prod).
7. Roadmap: A1 done, CHANGELOG.

## As built (2026-11-22)

Changes from the design above:

- `seatLastUsed` groups by `{ userId, agent }` and builds the seat key in
  code. A joined-string `_id` would look like an `activePairsPipeline` row,
  and the route tests' fake answers both aggregates with the same rows.
- `idleSince` is the later of the day after `lastUsed` and `startDate`. Use
  before a seat started does not count as idle time on that seat.
- The response adds `orgSeats` (seats in the org, admins only, null for
  managers). The page uses it to tell "no seats entered" from "none idle".
- `byTeam` leaves out holders in no visible team. No "no team" bucket.
- The page clamps a bad `?idleDays` in the URL to 14 rather than showing an
  error. The API still answers 400 to it.
- The `seatLastUsed` check sits in `apps/api/src/scripts/dashboard-pipelines.ts`
  (passed against a local replica set). No unit test in `seats.test.ts`: the
  logic is the pipeline. The seeded data has no zero-token day, so that case
  is covered by the shared `$match`, not by its own check.
- Added `components/SidebarNav.test.tsx` for the nav item order and the
  developer case.
- Not done here: the tag, the PR, merge and the prod smoke test.

