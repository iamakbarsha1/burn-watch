# R1 · B3 MCP server inventory: design

Status: built 2026-11-22, web-v0.5.0. Roadmap: `tasks/ROLLOUT-ROADMAP.md` R1.
Follows B1 (`tasks/R1-B1-FREE-TIER-DESIGN.md`), same page and same role rules.

## Goal

Admins see every MCP server their developers call, how much and by whom, and
mark each one approved. Anything not approved is flagged. MCP servers can read
code and reach outside systems, so an unknown one is a data-exposure risk.

## What the data says today

`mcpUsage` is a per-day map on `claudeEnrichment`: MCP server name to tool-call
count. The agent builds the name from the tool name `mcp__<server>__<tool>`
(`apps/agent/src/collectors/codeburn.ts:258`). Only Claude Code transcripts are
read, so Codex, Gemini and Copilot MCP use is not covered.

Prod, all time (read-only query, 2026-11-22). 81 enrichment docs, all with
`mcpUsage`, one user:

| server key | calls | days | last |
|---|---|---|---|
| playwright | 1498 | 24 | 2026-11-20 |
| atlassian | 779 | 25 | 2026-11-20 |
| plugin_claude-mem_mcp-search | 466 | 26 | 2026-11-19 |
| ccd_turn | 428 | 20 | 2026-11-18 |
| Neon | 138 | 7 | 2026-11-12 |
| plugin_vercel_vercel | 87 | 9 | 2026-11-20 |
| Claude_Browser | 50 | 7 | 2026-11-11 |
| context7 | 35 | 5 | 2026-11-11 |
| claude_ai_Atlassian_Rovo | 30 | 5 | 2026-11-20 |
| atlassian-concertcare | 25 | 1 | 2026-11-12 |
| 1a59c906-04da-521d-bda7-7f71b9f9e01c | 15 | 2 | 2026-10-26 |
| claude_ai_Claude_Docs, ccd_pr, terminal, visualize, claude_ai_Neon | ≤7 each | | |

What this shows:

1. **Keys are raw names, not identities.** The same service shows up under
   several keys: `Neon` (local server) and `claude_ai_Neon` (claude.ai
   connector); `atlassian`, `atlassian-concertcare` and `claude_ai_Atlassian_Rovo`.
   A local server's name is whatever the developer typed in their config, so
   two people can use the same server under different names, or different
   servers under the same name.
2. **Prefixes carry the source.** `plugin_<plugin>_<server>` is a Claude Code
   plugin, `claude_ai_<Name>` is a claude.ai connector. `ccd_*` looks like a
   Claude desktop built-in (not confirmed). A UUID key is a server with no
   readable name.
3. **No server URL or command is sent**, only the name. So B3 cannot tell what
   a server actually is. That is the privacy design (R0.3), and B3 keeps it.

## Scope

In:
- API `GET /governance/mcp?from&to&teamId`: inventory, one row per server key.
- API `PUT /governance/mcp-approvals` body `{ server, note? }` and
  `DELETE /governance/mcp-approvals?server=` (admin only): approve or
  un-approve one key, with an optional note.
- New collection `mcpApprovals`, one doc per (org, server key).
- `/governance` gets a second section, "MCP servers", under "Free-tier usage".
  Each row: server key, source hint, people, calls, days, last seen, status
  badge (approved / not approved). Admins get an Approve / Revoke button.
- Summary line: "N servers, M not approved, used by K people."

Out (named, not built):
- Alerts or emails on a new unapproved server (B2 has the alert path).
- Merging keys into one identity (see Decisions 2).
- Wildcard or pattern approvals, for example `plugin_*`.
- MCP use outside Claude Code.
- Blocking a server. BurnWatch only reports; it cannot stop a call.

## Data

`mcpApprovals` (new, in `packages/db/src/registry.ts` + `documents.ts`):

```ts
interface McpApprovalDoc {
  _id: string            // `${orgId}:${server}`, so a second approve is an upsert
  orgId: OrgId
  server: string         // exact key as the agent sends it
  note: string | null    // why, or what it is ("Jira via Atlassian's server")
  approvedBy: UserId
  approvedAt: Date
}
```

Index: `{ orgId: 1 }`. Prod needs `npm run sync -w @burn-watch/db` after
deploy, as with seats.

Server keys come from developer configs, so the route validates them as
strings of at most 200 characters and never uses them as a field path. Approval
is stored as a value, not a map key.

## API

New handlers in `apps/api/src/routes/dashboard/governance.ts`.

`GET /governance/mcp`: same role rules as B1 (admin org, manager own teams via
`readScope`, developer 403). Pipeline on `claudeEnrichment`, the same
`$objectToArray` + `$unwind` shape as `toolUsageTotals` in `activity.ts`:
`enrichmentMatch(range)` → unwind `mcpUsage` → `$group` by key: calls,
distinct users, distinct days, last date → sort by calls. Then join
`mcpApprovals` for the org and user names for each row.

Response:

```ts
{
  servers: Array<{
    server: string
    source: 'plugin' | 'claude.ai' | 'local' | 'unnamed'   // parsed from the key
    approved: boolean
    note: string | null
    users: Array<{ userId: string; name: string | null }>
    calls: number; days: number; lastDate: IsoDate
  }>
  // Approved keys nobody used in range, so an admin can still revoke them.
  unusedApprovals: Array<{ server: string; note: string | null }>
}
```

Managers see approvals (read only), so they know what is allowed.

`PUT /governance/mcp-approvals` body `{ server, note?: string | null }`,
`DELETE /governance/mcp-approvals?server=`: `requireAdmin`, orgId on every
filter, 200-character limit. Built change: the key moved out of the path,
because Fastify caps path params at 100 characters and a key may hold a `/`. These writes are a B8 audit-log
event later.

## Dashboard

- `governance/page.tsx`: second `Section`, "MCP servers". Same `TableFrame`
  pattern as the free-tier table.
- Approve / Revoke is a small client form posting to a server action, the same
  way `SeatsPanel` works. Hidden for managers. The page has no note field yet;
  the API accepts one.
- Empty state: "No MCP server calls in this range."
- A one-line note that only Claude Code is covered and that names come from
  each developer's config.

## Tests

- API: developer 403, manager scope on the `$match`, `$match` inside the org,
  approved flag from `mcpApprovals`, `source` parsing (plugin, claude.ai,
  local, UUID), unused approvals listed, PUT/DELETE admin only, PUT org-scoped
  `_id`, an over-long key returns 400.
- Dashboard: section renders rows and badges, buttons hidden for a manager.

## Release

Web feature: web-v0.5.0, CHANGELOG, tag `web-v0.5.0` with `--latest=false`,
prod schema sync for `mcpApprovals`.

## Decisions (2026-11-22)

1. **Audience:** like B1. Admins see the org and approve; managers see their
   own teams, read only; developers get 403.
2. **Key identity:** exact keys. `Neon` and `claude_ai_Neon` are two approvals.
   Aliases are out until someone needs them.
3. **Before any approvals:** every server shows "not approved", so the list
   works as a to-do.
4. **Org fact #3:** admins approve from the page. No seed list needed.

## Steps

1. `mcpApprovals` collection: doc type, registry, schema test.
2. Shared response types.
3. API: inventory route, approval PUT/DELETE, tests.
4. Dashboard: section, approve form + server action, tests.
5. Typecheck + tests, PR, CI, merge.
6. Prod schema sync, release web-v0.5.0, smoke test.
7. Roadmap: B3 done, CHANGELOG.
