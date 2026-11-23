# R2 · A6 Top quartile vs rest: design

Status: decisions locked and built as web-v0.17.0, 2026-11-23. Roadmap: `tasks/ROLLOUT-ROADMAP.md`
R2, row A6 ("Top quartile vs rest: MCP setup, skills, cache hit rate;
generated tips"). Builds on A5 (`tasks/R2-A5-FEATURE-MATRIX-DESIGN.md`).
A7 (champions) and D5 (shared setup) reuse the split defined here.

## Goal

Show admins and managers what their most active Claude Code users do that
the rest do not. One table compares the top quartile with everyone else on
MCP use, skills, subagents, plan mode and cache hit rate. Under it, up to
three fixed tips name the biggest gaps and what to try.

This doc defines "top quartile" once. A7 and D5 import it and do not
redefine it.

## What exists today

| Piece | Where | Today |
|---|---|---|
| Per-day feature flags | `apps/api/src/routes/dashboard/features.ts:20-31` | `featureFlags(doc)`: five flags per enrichment doc. In progress on `feat/r2-a5-feature-matrix`. |
| Per-person days | `features.ts:34-43`, `countFeatures` `:46-54` | `featureDays(docs)` gives days per feature; `sdk` null with no 0.4.0 day. |
| Feature route | `apps/api/src/routes/dashboard/adoption.ts:374` onward | `GET /adoption/features` returns `FeaturePerson[]` with `activeDays` and `days`. Admin or manager, `readScope`, `auditView`. |
| Shared types | `packages/shared/src/types.ts:631-664` | `FEATURE_KEYS`, `FeatureKey`, `FeaturePerson`, `FeatureMatrixResponse`. |
| MCP servers per person | `routes/dashboard/leaderboard.ts:147-155` | `mcpServersPipeline(range)`: distinct `mcpUsage` keys per user. |
| MCP source | `routes/dashboard/governance.ts:219-224` | `mcpSource(server)`: `plugin`, `claude.ai`, `unnamed`, `local` from the key prefix. |
| Cache hit rate per day | `packages/db/src/documents.ts:293`, written at `packages/db/src/usage.ts:179` | `dailySnapshots.cacheHitRate`, copied from the agent's enrichment (`apps/agent/src/collectors/codeburn.ts:296, 311`). |
| Cache tokens per row | `documents.ts:215-240`, index `registry.ts:94` | `usageEvents` carry `inputTokens`, `cacheCreateTokens`, `cacheReadTokens`, `agent`, `orgId`. Index `usageEvents_agent_date`. |
| Leaderboard cache column | `leaderboard.ts:359-363` | Returns `cacheHitRate: null`; the comment says a mean of daily rates is not the rate over the range. |

## What the data says today

Prod, read-only, 2026-11-23. 2 users with Claude Code data, 0 teams,
0 `mcpApprovals`.

| Measure | User 1 | User 2 |
|---|---|---|
| Enrichment days | 42 | 40 |
| Distinct MCP servers | 10 | 6 |
| Days with snapshot `cacheHitRate` = 0 | 27 of 42 | 0 of 40 |
| Mean of daily `cacheHitRate` | 34.7% | 95.2% |
| Token-weighted rate from `usageEvents` (Claude) | 97.3% | 97.8% |

16 distinct MCP server keys across the org; none is used by both users.

What this shows:

1. `dailySnapshots.cacheHitRate` is not trustworthy for history. User 1 has
   27 days at 0 from 2026-10-03 to 2026-10-29, and on 25 of them the usage
   events show cache reads. The cause is not checked. A6 computes the rate
   from `usageEvents` tokens instead.
2. Cache hit rate barely separates people today (97.3 vs 97.8). It stays a
   row, but tips on it need a wide gap to fire.
3. A quartile of 2 people is 1 person. The section must refuse to compare
   below a minimum population (Decision 2).

## Scope

In:
- `quartileSplit(people)`: the one shared definition of top quartile.
- `GET /v1/dashboard/adoption/practices`: the comparison for the scope.
- A "Top users vs rest" section on `/adoption`, after Features.
- A fixed table of rule-based tips (Decision 4).

Out:
- Names. A6 shows aggregates only. Champions (named) are A7.
- Server or skill names as a recommendation. That is D5.
- Changing A8's score or "features tried" (Decision 6).
- Non-Claude agents. Same rule as A5.
- Trends over time.

## Data

### Population

The people A5 returns for the scope: Claude Code users with at least one
enrichment day in range. Same `readScope`, same range clamp.

### The split

```ts
// apps/api/src/routes/dashboard/quartile.ts
export const MIN_QUARTILE_PEOPLE = 4
export function quartileSplit(people: FeaturePerson[], tokens: Map<UserId, number>):
  { top: UserId[]; rest: UserId[] } | null
```

- Returns null when `people.length < MIN_QUARTILE_PEOPLE` (Decision 2).
- Sort by `activeDays` desc, then Claude tokens in range desc, then
  `userId`. Top = first `ceil(n / 4)`. Rest = the others. Deterministic, so
  a tie at the cut always lands the same way.
- Ranked by active days, the same default as the A8 leaderboard
  (Decision 1). Not by any compared measure, so the comparison is not
  circular.

### Measures per person

All from data A5 already reads, plus one token query:

| Measure | From |
|---|---|
| Uses MCP, skills, subagents, plan | `days[k] > 0` on `FeaturePerson` |
| Share of active days with the feature | `days[k] / activeDays` |
| MCP servers | count of keys from `mcpServersPipeline` |
| Cache hit rate | `sum(cacheReadTokens) / sum(inputTokens + cacheCreateTokens + cacheReadTokens)` on `usageEvents`, `agent: 'claude'`, in range |

SDK is left out of the comparison: it is a 0.4.0 field and known for one
person on one day.

Per group the API returns the share of people who use each feature and the
median of each numeric measure. Medians, because one heavy user should not
move a group of eight.

The token query: `usageEvents.aggregate([{ $match: { orgId, agent: 'claude',
date: { $gte, $lte }, userId: { $in: people } } }, { $group: { _id:
'$userId', ... } }])`. Uses `usageEvents_agent_date`. It also returns the
token total the split needs for its tie break.

No new collection, index, or field.

## API

`GET /v1/dashboard/adoption/practices?from&to&teamId`

- 403 unless admin or manager. `readScope`, `scopeError`, and
  `auditView(request, 'adoption', scope, teamId)`, as the funnel and A5 do.

```ts
interface PracticeGroup {
  users: number
  uses: Record<'mcp' | 'skills' | 'subagents' | 'plan', number>   // share of people, 0..1
  dayShare: Record<'mcp' | 'skills' | 'subagents' | 'plan', number> // median
  mcpServers: number          // median
  cacheHitRate: number | null // median, percent; null if no Claude tokens
}
interface PracticeTip { id: TipId; gap: number }
interface PracticesResponse {
  from: string; to: string
  population: number
  minPopulation: number       // MIN_QUARTILE_PEOPLE, for the empty state
  top: PracticeGroup | null   // null below the minimum
  rest: PracticeGroup | null
  tips: PracticeTip[]         // at most 3, largest gap first
}
```

The team filter changes the population, so a team of 4 or more gets its own
quartile. A smaller team gets the empty state. No names or user ids in the
response.

## Tips

Rule-based (Decision 4). A constant table in `quartile.ts`; the page holds
the text keyed by `TipId`.

| TipId | Fires when | Text (draft) |
|---|---|---|
| `mcp` | `top.uses.mcp - rest.uses.mcp >= 0.25` | Most top users call MCP servers; most others do not. See which servers they use under Governance > MCP and add the useful ones to the team's setup. |
| `skills` | same rule on `skills` | Top users run skills on many of their days. Share the team's skills in the repo's `.claude/skills/` folder. |
| `subagents` | same rule on `subagents` | Top users hand work to subagents. Try asking Claude to split a large search or review across subagents. |
| `plan` | same rule on `plan` | Top users plan before they edit. Try plan mode (Shift+Tab) for changes that touch several files. |
| `cache` | `top.cacheHitRate - rest.cacheHitRate >= 10` | Others get fewer cache hits. Long tasks in one session, and fewer model switches mid-session, reuse more cached context. |

`gap` is the difference that fired the rule, so the page can sort. Text is
reviewed in the PR like any copy. No tip fires when no gap passes its rule.

## Dashboard

New section "Top users vs rest" on `/adoption`, after Features. Same range
and team picker.

- One line: "Top quarter by active days, compared with everyone else.
  Claude Code only."
- Table: Measure, Top, Rest. Rows: Uses MCP, MCP servers (median), Uses
  skills, Uses subagents, Uses plan mode, Cache hit rate (median).
- Tips under the table as a short list.
- Below the minimum: "Needs 4 or more Claude Code users in range. This
  scope has N." No table, no tips.
- Existing `Section`, `TableFrame`, `Th`, `Td`.

## Tests

- `quartileSplit`: null at 3, 1 top at 4, 2 top at 8, ceil at 9 (3
  top), tie on active days broken by tokens then `userId`, stable order.
- Measures: median of even and odd counts; cache rate with zero tokens is
  null; a person with no `usageEvents` row still counts in feature shares.
- Tips: each rule fires at its threshold and not one below; at most 3;
  sorted by gap.
- Route: 403 for developer; manager scope; team filter shrinks the
  population; response carries no user id or name; another org's events
  never count.
- Page: table, tips, empty state with the count.

## Release

Next web minor, `--latest=false`. No agent release, no schema sync.
Prod will show the empty state (2 people of 4).

## Decisions (locked 2026-11-23)

1. **What ranks people into the top quartile.** All three, as a picker:
   active days (default), Claude tokens, A8 score. API takes
   `?rankBy=days|tokens|score`. Ties go to Claude tokens, then `userId`.
   With A8 score the page says the MCP rows partly compare the score with
   itself. The score is computed within the A6 population, so the "top
   person" each part is measured against is this scope's top.
2. **Minimum population.** 4. At 4 to 7 people the top group is one
   person; chosen knowingly. `MIN_QUARTILE_PEOPLE = 4`.
3. **Cache hit rate source.** Token-weighted from `usageEvents`, as
   recommended.
4. **Generated tips.** Fixed rules and fixed text, as recommended.
5. **A5 "used" threshold.** Stays "1 day".
6. **A8 features tried.** A8 unchanged. Its score loop moved into
   `scoreAll()` in `leaderboard.ts` so A6 can rank by it; same output.

### Built differently from the draft above

- `quartileSplit(people)` takes `{ userId, rank, tokens }` rows, where
  `rank` is the picked measure, instead of `(people, tokens)`.
- Tip `gap` is always a share 0..1. The cache rule fires at 0.10 (10
  percentage points / 100), so tips sort on one scale.
- The response carries `rankBy`.
- Empty state reads "Needs 4 or more...".

## Steps

1. `quartile.ts`: `quartileSplit`, medians, tip rules; unit tests.
2. Shared types `PracticesResponse`, `PracticeGroup`, `TipId`.
3. Route in `adoption.ts`, reusing A5's people build and
   `mcpServersPipeline`; token aggregate; route tests.
4. `fetchPractices` in `apps/dashboard/src/lib/api.ts`, section, tip text,
   page test.
5. Typecheck and all suites. `/privacy` needs no change: `cacheHitRate`
   and `mcpUsage` are already `scoped` (`apps/dashboard/src/lib/transparency.ts:66, 75`).
6. Changelog, PR, merge, next web minor. Check prod `/adoption` shows the
   empty state.
