# R1 · B1 Free-tier usage list: design

Status: built 2026-11-22, shipped as web-v0.4.0. Decisions below. Roadmap: `tasks/ROLLOUT-ROADMAP.md` R1.

## Goal

Admins, and managers for their own teams, see who used a free-tier AI tool, on which model, on how many days and
with how many tokens, per user and per team. A free tier may let the provider
train on inputs, so this is where company or client code could leak.

Pure read over `usageEvents`. No schema change, no agent change, no migration.

## What the data says today

`isFreeTier` is set by the agent (`apps/agent/src/collectors/ccusage.ts:80,93`):

```ts
isFreeTier: FREE_TIER_AGENTS.has(agent) || cost === 0   // FREE_TIER_AGENTS = {'qwen'}
```

Prod `usageEvents`, all time (read-only query, 2026-11-22):

| agent | isFreeTier | rows | users | tokens |
|---|---|---|---|---|
| qwen (`coder-model`) | true | 12 | 1 | 1.06B |
| claude, codex, copilot, gemini | false | 211 | ≤2 | 7.4B |

Two gaps follow from the agent rule:

1. **False positives.** `cost === 0` also fires for any model ccusage has no
   price for (a new Claude or Codex model). That is "unpriced", not "free tier".
   No such rows exist in prod today.
2. **Gemini free tier is invisible.** Gemini CLI signed in with a personal
   Google account is free, but ccusage prices it at list rate, so the row has a
   cost and `isFreeTier: false`. The proposal names Gemini as a B1 target. The
   agent cannot tell today; it would need to read Gemini CLI's auth type
   (for example `selectedAuthType` in `~/.gemini/settings.json`). That is an
   agent change, so it is out of B1.

## Scope

In:
- API `GET /governance/free-tier?from&to&teamId` (admin: whole org; manager: own teams via `viewerScope`; member: 403).
- Dashboard page `/governance`, admins and managers, first section "Free-tier usage".
  B2 and B3 add sections to the same page later.
- Each row says *why* it was flagged: `free-tier agent` (agent in a known
  free-tier list) or `unpriced model` (cost 0, any other agent).

Out (named, not built):
- Gemini auth-type detection (agent change, new ticket).
- Alerts or emails on new free-tier use (B2 has the alert path).
- Per-provider legal summary. The page links to each provider's terms instead.

## API

`GET /governance/free-tier` in a new `apps/api/src/routes/dashboard/governance.ts`,
registered in `routes/dashboard/index.ts`. Members get 403. Admins read the whole org;
managers are limited to `viewerScope(request.user)` (self + members of teams they
manage), and a `teamId` they do not manage returns the existing 403 from `query-schema.ts`.

Query: `from`, `to` (existing `query-schema.ts` date rules), optional `teamId`
(reuse `teamIdField` from `query-schema.ts`, as overview and trends do).

Pipeline on `usageEvents`:
`$match {orgId, isFreeTier: true, date: {$gte, $lte}, userId ∈ scope ∩ team members}`
→ `$group {userId, agent, modelName}`: `days` (distinct dates), `tokens`,
`firstDate`, `lastDate` → join `users` (orgId on the join) → join team names.

Response:

```ts
{
  rows: Array<{
    userId: string; userName: string | null; userEmail: string | null
    teams: string[]
    agent: AgentName; modelName: string
    reason: 'free-tier-agent' | 'unpriced-model'
    days: number; tokens: number; firstDate: IsoDate; lastDate: IsoDate
  }>
  byTeam: Array<{ teamId: string | null; teamName: string | null; users: number; tokens: number }>
}
```

`reason` is computed server-side from the agent list, so the split needs no
new stored field. Schema goes in `packages/shared` next to the other dashboard
types.

Index: `usageEvents_key` and `usageEvents_agent_date` exist. Org-wide free-tier
rows are tiny today; check `explain()` once and only add an index if it scans
the collection on a real org.

## Dashboard

- `apps/dashboard/src/app/(dashboard)/governance/page.tsx`, server component,
  same fetch pattern as `admin`. Members get redirected, like `/admin` does for non-admins.
- Sidebar: add `{ href: '/governance', label: 'Governance' }`, shown to
  admins and managers (extend the role filter at `SidebarNav.tsx:61`).
- Reuse `RangeBar` and `TeamFilter`. One table: user, teams, agent · model,
  reason badge, days, tokens, last seen. A per-team summary line above it.
- Empty state: "No free-tier usage in this range." plus one line on the
  Gemini gap, so an empty list is not read as "nobody uses Gemini free".

## Tests

- API: member gets 403, manager sees only their teams' users, manager asking for
  another team's `teamId` gets 403, admin sees the org, org isolation (another org's
  free-tier rows never appear), team filter, `reason` split, date range edges.
  Note: the Mongo fake ignores filters (`MongoFakeState`), so filter tests
  assert the pipeline `$match` shape, as the existing route tests do.
- Dashboard: page renders rows and the empty state.

## Release

Web feature: bump dashboard + API to 0.4.0, CHANGELOG entry, tag `web-v0.4.0`,
GitHub release with `--latest=false`.

## Decisions (2026-11-22)

1. **Unpriced models:** shown, with an "unpriced model" badge.
2. **Audience:** admins see the org; managers see their own teams from day one.
   Members do not see the page. Manager views are not logged until B8 ships.
3. **Gemini gap:** page note now, plus a ticket for agent-side Gemini auth
   detection in R2.

## Steps

1. Shared response schema + type.
2. API route, pipeline, tests.
3. Dashboard page, sidebar entry, tests.
4. Typecheck + tests on all tasks, PR, CI, merge.
5. Release web-v0.4.0, prod smoke (401 signed out, page signed in).
6. Roadmap: mark B1 done, TICKETS.md updated.
