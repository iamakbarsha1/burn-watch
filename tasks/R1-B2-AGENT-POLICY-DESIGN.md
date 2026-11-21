# R1 · B2 Approved agents and models policy: design

Status: built 2026-11-22, web-v0.6.0. Roadmap: `tasks/ROLLOUT-ROADMAP.md` R1.
Follows B1 (`tasks/R1-B1-FREE-TIER-DESIGN.md`) and B3 (`tasks/R1-B3-MCP-INVENTORY-DESIGN.md`):
same page, same role rules, same "admins fill the list on the page" approach.

## Goal

Admins say which agents, and optionally which models, the org allows. Usage
outside that policy shows up as a violation list on `/governance`, with a
dashboard alert so admins notice it without opening the page. This turns a
policy that lives on paper into one people can check.

## What the data says today

`usageEvents` has `agent` (closed set: claude, qwen, gemini, codex, copilot)
and `modelName` (free text from the agent or the Copilot API). Prod, all time
(read-only query, 2026-11-22), one org, 6 users:

| agent | models seen | last used |
|---|---|---|
| claude | claude-opus-5, claude-opus-5-5, claude-sonnet-5, claude-sonnet-5-5, claude-sonnet-4-6, claude-haiku-4-5-20251001, claude-haiku-5-5, claude-fable-5-1, claude-fable-5-2 | 2026-11-20 |
| codex | gpt-5.4, gpt-5.3-codex, gpt-5.2-codex | 2026-03-18 |
| copilot | claude-sonnet-4.5, claude-opus-4.7, claude-haiku-4.5, gpt-5.4, gpt-5.3-codex | 2026-07-10 |
| gemini | gemini-3-flash-preview, gemini-3.1-pro-preview, gemini-3.1-pro-preview-customtools | 2026-04-24 |
| qwen | coder-model (free tier) | 2026-04-14 |

What this shows:

1. **Agents are a fixed set of 5.** An agent-level policy is 5 rows.
2. **Model names churn.** Claude alone shows 9 names in about a month; a new
   one lands with every release (`opus-5` then `opus-5-5`). An exact-name
   model allowlist would flag every new release as a violation until an admin
   adds it.
3. **The same model has different names per agent.** `claude-sonnet-4.5`
   under Copilot, `claude-sonnet-4-6` under Claude Code. So model rules belong
   under an agent, not across agents.
4. **Model names are not validated.** They come from agent output or the
   Copilot API, so they are matched as plain strings, never used as field paths.

## Scope

In:
- New collection `agentPolicies`, one doc per (org, agent).
- Each agent's rule is one of:
  - `allowed`: every model on this agent is fine.
  - `models`: only the listed model names are fine, exact match (Decision 2).
  - `blocked`: any use is a violation.
  - no doc: see Decision 3.
- API `PUT` and `DELETE /governance/agent-policy/:agent` (admin only). The
  policy itself is read through the violations route (built change: no
  separate GET).
- API `GET /governance/violations/count` (admin only): violation groups in
  the last 30 days, for the alert.
- API `GET /governance/violations?from&to&teamId`: usage rows outside the
  policy, grouped per (user, agent, model), same shape and role rules as B1.
- `/governance` gets a "Agent and model policy" section: the 5 agents with
  their rule (editable for admins), then the violation list.
- Dashboard alert (Decision 4).

Out (named, not built):
- Push alerts (Slack, Teams, email). Waits on the notification channel.
- Blocking usage. BurnWatch only reports.
- Per-team or per-client policy (B7, needs C1).
- History of policy changes (B8 audit log).
- Judging past usage against the policy in force at that time. Violations are
  always computed against the current policy, over the chosen range.

## Data

`agentPolicies` (new, in `packages/db/src/registry.ts` + `documents.ts`):

```ts
interface AgentPolicyDoc {
  _id: AgentPolicyKey      // `${orgId}:${agent}`, so a re-save is an upsert
  orgId: OrgId
  agent: AgentName
  rule: 'allowed' | 'models' | 'blocked'
  models: string[]         // rule 'models' only; [] otherwise. Max 50, each ≤ 200 chars
  note: string | null
  updatedBy: UserId
  updatedAt: Date
}
```

Index: `{ orgId: 1 }`. Prod needs `npm run sync -w @burn-watch/db` before
the merge, as with B3.

## API

In `apps/api/src/routes/dashboard/governance.ts`.

`GET /governance/violations`: admin org-wide, manager own teams via
`readScope`, developer 403. Read the org's policies, build one `$match` on
`usageEvents`:

```
{ orgId, date in range, [userId in scope],
  $or: [
    { agent: { $in: blockedAgents } },
    { agent: { $in: agentsWithNoPolicy } },          // only if Decision 3 = flag
    { agent: A, modelName: { $nin: models } },       // per 'models' agent, exact names
  ] }
```

Then the same `$group` as `freeTierPipeline` (user, agent, model: days,
tokens, first/last date) and the same user and team naming. Each row carries
`reason: 'agent-blocked' | 'agent-not-set' | 'model-not-listed'`. Empty `$or`
means no query at all, and an empty list.

Response:

```ts
{
  policies: AgentPolicy[]            // all 5 agents, rule 'unset' where no doc
  rows: ViolationRow[]               // FreeTierRow shape with a different reason
  byTeam: FreeTierTeamTotal[]
  seenModels: Partial<Record<AgentName, string[]>>   // admins only, for the edit form
}
```

Built: B1 and B2 share one grouping pipeline (`usageGroupPipeline`) and one
naming helper (`nameGroups`) in `governance.ts`.

`PUT /governance/agent-policy/:agent` body `{ rule, models?, note? }`:
`requireAdmin`, `agent` checked with `AgentNameSchema` (a closed set, so it
is safe in the path), orgId on every filter. `DELETE` resets to unset. These
writes are a B8 audit-log event later.

## Dashboard

- `governance/page.tsx`: third `Section`, "Agent and model policy", between
  free-tier and MCP.
- A row per agent: rule badge (allowed / models only / blocked / not set),
  model list, note. Admins get an edit form per row (rule select, a textarea
  of models one per line, note), posting to a server action like B3's.
  Managers read only.
- Under it, the violation table: person, teams, agent · model, reason badge,
  days, tokens, last seen. Empty state: "No usage outside the policy in this
  range."
- A "Seen models" hint under each agent's edit form: model names used in the
  range, so an admin can copy them into the list instead of typing. Matching is
  exact (Decision 2), so this is how a new release gets added quickly.
- Dashboard alert (Decision 4): a banner on `/governance`, a violation count
  on the Governance nav item, and a line on Overview, all for admins only.
  The count is the number of violation rows in the last 30 days, from one
  aggregate shared by the three places.

## Tests

- API: developer 403, manager scope on `$match`, `$match` inside the org,
  each reason (blocked, not set, model not listed), no `$or` branches means no
  aggregate, exact model match (`claude-opus-5` does not cover
  `claude-opus-5-5`), PUT/DELETE admin
  only and org-scoped `_id`, unknown agent 400, over 50 models 400.
- Dashboard: policy rows and badges, edit form hidden for a manager, violation
  rows and empty state, the banner, nav count and Overview line for admins
  only.

## Release

Web feature: web-v0.6.0, CHANGELOG, prod schema sync for `agentPolicies`
before merge, tag `web-v0.6.0` with `--latest=false`.

## Decisions (2026-11-22)

1. **Audience:** like B1 and B3. Admins set the policy and see the org;
   managers see their teams' violations and the policy, read only; developers
   get 403. (Default taken, not asked.)
2. **Model matching:** exact names. A new model release is a violation until
   an admin adds it. Chosen over prefix patterns; the "Seen models" hint keeps
   adding one quick.
3. **Agents with no rule:** flagged, like B3. Every agent is a violation until
   an admin sets its rule, so the list works as a to-do.
4. **Dashboard alert:** banner on `/governance`, count on the Governance nav
   item, and a line on Overview, admins only. Push alerts wait for a channel.
5. **Org fact #3 (agents half):** admins fill the policy on the page; no seed
   list needed. (Default taken, not asked.)

## Steps

1. `agentPolicies` collection: doc type, key, registry.
2. Shared schemas and response types.
3. API: policy GET/PUT/DELETE, violations route, tests.
4. Dashboard: policy section, edit form + server action, violation table,
   alert, tests.
5. Typecheck + tests, PR, CI.
6. Prod schema sync, merge, release web-v0.6.0, smoke test.
7. Roadmap: B2 done, CHANGELOG.
