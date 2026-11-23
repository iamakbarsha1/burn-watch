# R2 · D6 Onboarding score: design

Status: draft 2026-11-23, decisions open. Roadmap: `tasks/ROLLOUT-ROADMAP.md`
R2, row D6 ("Onboarding score: weekly active + 2 features within 14
days"). Builds on A3 (`tasks/R1-A3-ADOPTION-FUNNEL-DESIGN.md`) for first
sync and the active rule, and A5 (`tasks/R2-A5-FEATURE-MATRIX-DESIGN.md`)
for features. Does not need A6.

## Goal

Tell admins and managers whether new people get going. A person is
onboarded when, in the 14 days from their first sync, they keep using AI
tools into the second week and try at least 2 Claude Code features. The
team score is the share of new people who made it. The page also lists who
is still inside their 14 days and who missed.

## What exists today

| Piece | Where | Today |
|---|---|---|
| First sync | `apps/api/src/routes/dashboard/adoption.ts:126-175` (`funnelUsersPipeline`), `:151` | `$min date` of `dailySnapshots` with tokens, all time, per user. |
| Active rule | `adoption.ts:44-47` (`funnelThresholds`) | Active = tokens on `min(2, rangeDays)` days; A3 Decision 1 sets 2 days per 7. |
| Stage logic | `adoption.ts:72-77` (`stageOf`) | Registered, first sync, active, power. |
| Feature flags | `apps/api/src/routes/dashboard/features.ts:20-43` | `featureFlags(doc)`, `featureDays(docs)`. In progress on `feat/r2-a5-feature-matrix`. |
| Funnel route | `adoption.ts:275` | Same roles, scope and audit D6 uses. Stuck list covers people with no first sync. |
| Enrichment | `packages/db/src/documents.ts:257-281`, index `registry.ts:98` | One doc per Claude Code user-day. |

## What the data says today

Prod, read-only, 2026-11-23. 6 users, 2 with usage, 0 teams.

| | First sync | First enrichment day | Enrichment days in first 14 from that day |
|---|---|---|---|
| User 1 | 2026-03-17 | 2026-10-03 | 14 (MCP 12, skills 12, subagents 9, plan 1) |
| User 2 | 2026-05-20 | 2026-09-09 | 8 (MCP 1, subagents 3) |

The 4 other users have no first sync yet.

What this shows:

1. Both existing users first synced months before the earliest enrichment
   day in prod (2026-09-09). Their real first 14 days have no feature data.
   D6 cannot score them and must say so, not count them as failures.
2. The 4 users without a first sync are A3's stuck list. D6 does not
   repeat them.
3. So prod shows 0 people scored today. The section earns its place when
   the next person joins.

## Scope

In:
- `onboardingOf(person)`: pure function, one person's result.
- `GET /v1/dashboard/adoption/onboarding?from&to&teamId`.
- An "Onboarding" section on `/adoption`, after Funnel.

Out:
- People with no first sync. A3 lists them.
- Nudges to people who are behind. Waits on the notification channel.
- A stored score or history. Computed on read.
- Changing A3's thresholds.

## Data

### Who is in the cohort

Users in scope whose first sync falls in the page range (Decision 3). The
first sync comes from the same `$min date` A3 uses. For a 30-day range that
is "people who started in the last 30 days".

### One person's window

`start` = first sync. `end` = `start + 13`. Week 1 = days 1 to 7, week 2 =
days 8 to 14. Days are UTC dates, as everywhere else.

```ts
type OnboardingState = 'onboarded' | 'missed' | 'inProgress' | 'noFeatureData'
interface OnboardingResult {
  state: OnboardingState
  activeWeek2: number          // days with tokens in days 8..14
  features: FeatureKey[]       // used at least once in days 1..14
  dayOfWindow: number          // 1..14, or 14 when done
}
```

Rules, in order:

1. `noFeatureData`: no `claudeEnrichment` doc in the window. Covers
   pre-enrichment history and people who only use other agents (Decision 4).
2. Onboarded when both hold, checked as soon as they hold:
   - Weekly active: tokens on 2 or more days in week 2 (Decision 1). Any
     agent counts, as in A3.
   - 2 or more of A5's features used at least once in the window, from
     `featureDays` over the window's enrichment docs (Decision 2). SDK
     counts when known.
3. `inProgress`: not yet onboarded and `end` is after the last synced day
   (today minus 1).
4. `missed`: window over, not onboarded.

### Reads

For the cohort's user ids only, two finds bounded by
`[min(start), max(end)]`:

- `dailySnapshots.find({ orgId, userId: { $in }, date, totalTokens: { $gt: 0 } }, { projection: { userId: 1, date: 1 } })`,
  index `dailySnapshots_org_date`.
- `claudeEnrichment.find({ orgId, userId: { $in }, date }, { projection: <A5 fields> })`,
  index `claudeEnrichment_org_date`.

Then cut each person's rows to their own window in Node. A cohort is small
(new people in one range), so this stays cheap.

First sync per user: reuse `funnelUsersPipeline` (`adoption.ts:126`), which
already returns `firstSync`. No new pipeline.

No new collection, index, or field.

## Minimum population

A team score is a percentage of people whose window is over (`onboarded`
plus `missed`). The page shows "n of m" always, and the percentage only
when m is 5 or more (Decision 5). One person is 0% or 100%, which reads as
a grade, not a trend.

## API

`GET /v1/dashboard/adoption/onboarding?from&to&teamId`. Admin or manager,
`readScope`, `scopeError`, `auditView(request, 'adoption', scope, teamId)`.

```ts
interface OnboardingCounts {
  cohort: number
  onboarded: number; missed: number; inProgress: number; noFeatureData: number
}
interface OnboardingPerson extends OnboardingResult {
  userId: string; name: string; teamIds: string[]; firstSync: string
}
interface OnboardingResponse {
  from: string; to: string
  total: OnboardingCounts
  teams: ({ teamId: string; teamName: string } & OnboardingCounts)[]
  noTeam: OnboardingCounts | null   // admin, no filter
  people: OnboardingPerson[]        // missed and inProgress only
}
```

`people` lists those who may need help, like A3's stuck list, so it does
not apply "Hide my name" (A5 Decision 5 drew the same line for the stuck
list). Names, no emails.

## Dashboard

"Onboarding" section on `/adoption`, after Funnel and before Features.

- One line: "New people in this range. Onboarded = tokens on 2+ days in
  their second week and 2+ Claude Code features in their first 14 days."
- Table: Team, New, Onboarded, Missed, In progress, No feature data. The
  Onboarded cell shows "n of m", plus "%" when m is 5 or more.
- Collapsed `<details>` lists: "In progress" (name, team, day 6 of 14,
  what is still missing) and "Missed" (name, team, first sync, what was
  missing).
- Empty state: "Nobody had a first sync in this range."

## Tests

- `onboardingOf`: day 7 vs day 8 boundary for week 2; exactly 2 active days
  in week 2 passes, 1 fails; exactly 2 features passes; SDK null ignored,
  SDK true counts; day 14 counts, day 15 does not; onboarded early (day 9)
  before the window ends; `inProgress` vs `missed` around today minus 1;
  no enrichment doc gives `noFeatureData` even with tokens.
- Route: developer 403; manager scope; team filter; `noTeam` admin only;
  first sync before `from` is out of the cohort; another org's rows never
  count.
- Page: "n of m" without % below 5, with % at 5; lists; empty state.

## Release

Next web minor, `--latest=false`. No agent release, no schema sync. Prod
shows the empty state for ranges after 2026-05-20, which is correct.

## Decisions (open)

1. **"Weekly active".** Tokens on 2 or more days in week 2 (days 8 to 14).
   Recommended: it reuses A3's "2 days" rule and checks people came back
   after the first week, which week 1 alone cannot show. Other choices:
   2 days in each of week 1 and week 2 (stricter), or 2 days anywhere in 14
   (passes someone who stopped on day 3).
2. **Which features count.** Any 2 of A5's five, each on 1 day or more.
   Recommended. Other choice: a fixed pair (say MCP and skills), which
   bakes one team's habits into the score.
3. **Cohort.** First sync inside the page range. Recommended: the range
   picker already means "this period" everywhere. Other choice: a fixed
   last 90 days, which ignores the picker.
4. **People with no Claude Code data in the window.** `noFeatureData`,
   left out of the score. Recommended: features are Claude Code only (A5),
   and old history predates enrichment. Other choice: score them on weekly
   active alone, which makes the score mean two things.
5. **Minimum for a percentage.** 5 people with a finished window.
   Recommended. Below that, show counts only.
6. **Hide my name.** Not applied to the lists. Recommended, same reasoning
   as A3's stuck list: it lists people to help, it does not rank them.

## Steps

1. `onboarding.ts` with `onboardingOf` and counts; unit tests.
2. Shared types.
3. Route in `adoption.ts`: cohort from `funnelUsersPipeline`, two finds,
   per-person windows; route tests.
4. `fetchOnboarding` in `apps/dashboard/src/lib/api.ts`, section, page test.
5. Typecheck and all suites. `/privacy` needs no change.
6. Changelog, PR, merge, next web minor. Check prod `/adoption` empty state.
