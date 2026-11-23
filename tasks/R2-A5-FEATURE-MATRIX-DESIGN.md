# R2 · A5 Feature matrix per team: design

Status: built 2026-11-23 as web-v0.14.0 (decisions locked 2026-11-23, all six as recommended). Roadmap: `tasks/ROLLOUT-ROADMAP.md`
R2. Follows A3 (`tasks/R1-A3-ADOPTION-FUNNEL-DESIGN.md`) for the page, scope
and team rows. A6, A7 and D6 build on the per-person rows defined here.

## Goal

Admins and managers see, per team, how many Claude Code users used each of
five features in the page's date range:

| Feature | Question it answers |
|---|---|
| MCP | Did they call any MCP server tool? |
| Skills | Did they run a skill? |
| Subagents | Did they hand work to a subagent? |
| Plan mode | Did they plan before editing? |
| SDK | Did they run Claude Code from the SDK, not only the CLI? |

A second table lists each person with a mark per feature. A6 (top quartile),
A7 (champions) and D6 (onboarding score) all need "who used what", so this
table is the base they share.

## What exists today

Four of the five signals are already stored for every agent version. Only
CLI vs SDK needs agent 0.4.0. A5 needs no agent release and no schema change.

| Piece | Where | Today |
|---|---|---|
| Tool counts | `apps/agent/src/collectors/codeburn.ts:211-221` | Every `tool_use` block that is not Bash or MCP lands in `toolUsage`, keyed by the tool name in lower case. All agent versions. |
| MCP counts | `codeburn.ts:216-218`, `schemas.ts:86` | `mcpUsage`: tool calls per MCP server. All agent versions. |
| 0.4.0 fields | `codeburn.ts:201, 245-247`, `schemas.ts:90-97` | `entrypointCounts`, `skillCounts`, `sidechainMessages`, `permissionModeCounts`. Optional. |
| Stored copy | `packages/db/src/documents.ts:257`, index `registry.ts:98` | `claudeEnrichment`, one doc per user per day, index `{ orgId, date }`. |
| Funnel route | `apps/api/src/routes/dashboard/adoption.ts:272-376` | `GET /v1/dashboard/adoption/funnel`: admin or manager, `readScope` (`plugins/jwt.ts:144`), `auditView(request, 'adoption', ...)`, team rows from `comparableTeams`, `noTeam` for admins only. |
| Page | `apps/dashboard/src/app/(dashboard)/adoption/page.tsx:30-135` | Idle seats, then Funnel. Shared date range and team picker. |
| A8 "features tried" | `routes/dashboard/leaderboard.ts:144-150, 275-277` | Agents used plus distinct MCP servers. Not changed here (Decision 6). |

### Which field to read for each feature

| Feature | Read | Why not the obvious field |
|---|---|---|
| MCP | `mcpUsage` has any key | n/a |
| Skills | `toolUsage.skill > 0` or `skillCounts` has any key | `skillCounts` comes from `attributionSkill`, which Claude Code sets on few lines. On this Mac's last two days of logs: 136 `Skill` tool calls, `attributionSkill` in 2 files. Prod has no `skillCounts` keys at all, but 702 `skill` tool calls. |
| Subagents | `toolUsage.agent`, `toolUsage.task` > 0, or `sidechainMessages > 0` | The tool is named `Agent` today and was `Task` before. The tool call works on pre-0.4.0 agents; `sidechainMessages` does not. |
| Plan mode | `toolUsage.exitplanmode`, `toolUsage.enterplanmode` > 0, or `permissionModeCounts.plan > 0` | `permissionModeCounts` is 0.4.0 only. The plan tools are seen on older agents. |
| SDK | `entrypointCounts` has a key other than `cli` | 0.4.0 only. With no 0.4.0 day in range the person shows "unknown" (Decision 4). |

All five are Claude Code only. Codex, Gemini, Qwen and Copilot users are
not in the matrix denominator. The page says so in one line.

## What the data says today

Prod, read-only, 2026-11-23. 82 `claudeEnrichment` docs from 2 users,
2026-09-09 to 2026-11-21. 0 teams.

| Signal | Days with it | Users | First seen |
|---|---|---|---|
| MCP (`mcpUsage` non-empty) | 60 | 2 | |
| `toolUsage.skill` (702 calls) | 41 | 2 | 2026-10-05 |
| `toolUsage.agent` (322 calls) | 37 | 2 | 2026-09-11 |
| `toolUsage.exitplanmode` / `enterplanmode` | 4 / 3 | 1 | 2026-10-13 |
| `entrypointCounts` (`cli` 1,259, `sdk-ts` 32) | 1 | 1 | 2026-11-21 |
| `permissionModeCounts` (`bypassPermissions`, `dontAsk`) | 1 | 1 | 2026-11-21 |
| `skillCounts` | 0 | 0 | |

So the page is useful for history from day one. The SDK column fills in as
devices move to agent 0.4+. With 0 teams in prod, it shows the total row
and the No team row, as A3 does.

## Scope

In:
- `GET /v1/dashboard/adoption/features`, same query and roles as the funnel.
- Team table and people table on `/adoption`.
- One shared helper, `featureFlags(doc)`, that turns one enrichment doc into
  the five booleans. A6, A7 and D6 call it too.

Out:
- Agent changes. The `attributionSkill` gap stays; the tool call is the
  better skill signal anyway.
- Skill or MCP server names per team. That is D5 ("recommended shared
  set") and B3 already lists MCP servers.
- Changing A8's score (Decision 6).
- Non-Claude agents.

## Data

One aggregation on `claudeEnrichment`, `{ orgId, date: { $gte, $lte } }`
(uses `claudeEnrichment_org_date`), optional `userId: { $in: scope }`.
Per doc, project only the fields above. Group by `userId`. Each feature is
counted as days used in range, so the people table can show "3 days"
and Decision 2 can pick a threshold later without a new query.

```ts
type FeatureKey = 'mcp' | 'skills' | 'subagents' | 'plan' | 'sdk'
type FeatureDays = Record<FeatureKey, number>
```

`sdk` is `null` for a person with no doc that has `entrypointCounts`.
Then `featureFlags()` is a pure function over one doc, tested on its own.
It runs in Node after the query; at about 30 docs per person per month this
is small. If an org grows past that, move it into the pipeline.

No new collection, index, or org field. No schema sync.

## API

`GET /v1/dashboard/adoption/features?from&to&teamId`

- 403 unless admin or manager. Same `readScope`, `scopeError` and
  `auditView(request, 'adoption', scope, teamId)` as the funnel.
- No range clamp: unlike the funnel, there is no threshold that scales with the range.

```ts
interface FeatureMatrixResponse {
  from: string; to: string
  /** People in scope with at least one Claude Code day in range. */
  total: FeatureCounts
  teams: ({ teamId: string; teamName: string } & FeatureCounts)[]
  noTeam: FeatureCounts | null      // admin, no team filter
  people: FeaturePerson[]
}
interface FeatureCounts {
  users: number
  used: Record<FeatureKey, number>  // people over the threshold
  sdkKnown: number                  // people with a 0.4.0 day
}
interface FeaturePerson {
  userId: string; name: string; teamIds: string[]
  activeDays: number
  days: Record<FeatureKey, number | null>
}
```

Types go in `packages/shared/src/types.ts`, next to `FunnelResponse`.

## Dashboard

New `Features` section on `/adoption`, after Funnel. Uses the page's range
and team picker, and the existing `Section`, `TableFrame`, `Th`, `Td`,
`Badge`.

- Team table: Team, Users, then one column per feature as `n of m`.
  The SDK column shows `n of k` with k = `sdkKnown`, and a dash when k is 0.
- People table: Name, Team, Active days, one column per feature showing
  the day count, or a dash for none. Sorted by features used, then name.
- One line under the heading: "Claude Code only. SDK needs agent 0.4 or
  later."
- Empty state when no one in scope has a Claude Code day in range.

## Tests

- `featureFlags()`: each feature from its old field, its 0.4.0 field, both,
  neither; `task` and `agent` both count; `entrypointCounts: { cli }` is
  SDK false, missing is null.
- Route: 403 for developer; manager sees only managed teams; team filter;
  `noTeam` only for admin with no filter; empty range.
- Person in two teams counts in both team rows, once in `total`.
- Page test: renders both tables, dash for unknown SDK, empty state.

## Release

Web release `web-v0.14.0`, `--latest=false` (memory: release per change).
No agent release, no schema sync, no migration.

## Decisions (locked 2026-11-23)

1. **Signals.** Read the tool calls first (table above), with 0.4.0 fields
   as a second source. Recommended. The other choice, 0.4.0 fields only,
   leaves the page empty until agents update.
2. **What "used" means.** At least 1 day in range. Recommended for now; a
   threshold like 2 days can come with A6 when there is more data.
3. **People table for managers.** Show it, scoped to their teams, as the
   funnel's stuck list does. Recommended. The other choice is admin only.
4. **SDK with no 0.4.0 data.** Show a dash and count `sdkKnown`.
   Recommended. Counting them as CLI would understate SDK use.
5. **A8 "Hide my name"** (`users.hideOnLeaderboard`, rule at
   `leaderboard.ts:331`). Respect it in the people table: managers see
   "Hidden", admins see the name. Recommended, because a feature list
   ranks people the way the leaderboard does. The funnel's stuck list does
   not respect it today and keeps that behaviour, because it lists people
   who need help and does not rank anyone.
6. **A8 features tried.** Leave A8's score as it is now. Recommended.
   Switching it to these five features changes everyone's score; do it
   with A6 if at all.

## Steps

1. `featureFlags()` and its tests in `apps/api/src/routes/dashboard/`.
2. Shared types.
3. Route in `adoption.ts`, route tests.
4. `fetchFeatures` in `apps/dashboard/src/lib/api.ts`, Features section,
   page test.
5. Typecheck and all suites; `/privacy` needs no change (no new field
   stored).
6. Changelog, PR, merge, `web-v0.14.0`. Check prod `/adoption` signed in.
