# R2 · C4 Usage per ticket: design

Status: design drafted 2026-11-23, decisions open. Roadmap: `tasks/ROLLOUT-ROADMAP.md`
R2. Builds on the branch data R0.3 added (`tasks/R0.3-AGENT-PRIVACY-DESIGN.md`,
decision 8) and on the Projects page.

## Goal

People see Claude Code cost and sessions per ticket, where the ticket key
comes from the Git branch name. A branch named `PROJ-123-fix-login` counts
toward `PROJ-123`. A second table rolls tickets up by project key (`PROJ`).

The roadmap line also says "epic". An epic is a Jira parent link, not part of
the branch name, so it needs a Jira integration. That is out of scope here
(Decision 6).

## What exists today

The agent already sends branch names with cost and sessions, and the server
already stores them. Nothing reads them. C4 needs no agent release and no
wire change.

| Piece | Where | Today |
|---|---|---|
| Branch tally | `apps/agent/src/collectors/codeburn.ts:269-279` | Per project per day: cost and session set per `gitBranch`. `HEAD` and empty skipped. Name cut at 200 characters. |
| Branch rows sent | `codeburn.ts:324-326` | `projectBreakdown[].branches`, top 50 by cost per project per day. |
| Wire schema | `packages/shared/src/schemas.ts:42-46, 57-61` | `BranchEntrySchema { name, cost, sessions }`, optional, agent 0.4.0+. No token counts. |
| Stored copy | `packages/db/src/documents.ts:257-264` | `ClaudeEnrichmentDoc.projectBreakdown`, one doc per user per day. Stored as sent (`apps/api/src/routes/usage/submit.ts:101-102`). |
| Projects route | `apps/api/src/routes/dashboard/projects.ts:36-62, 64-90` | `$unwind` on `projectBreakdown`, group by remote or name. `viewerScope`: admin all, manager own teams, developer self. No audit. |
| Projects page | `apps/dashboard/src/app/(dashboard)/projects/page.tsx:8-80` | One table: project, value, sessions, avg, users. |
| /privacy audience | `apps/dashboard/src/lib/transparency.ts:70` | `'enrichment.projectBreakdown[].branches': 'none'`. Changes to `'scoped'` when this ships. |
| Org settings | `documents.ts:26-37`, `routes/dashboard/leaderboard.ts:394-402` | Admin settings live on `OrganizationDoc`. Leaderboard settings are the pattern: admin-only PUT, `audit()` call. |
| Jira | `documents.ts:107-114` | `OrgIntegrationDoc.provider` is `'copilot'` only. No Jira link. |

R0.3 decision 8 chose full branch names, parsed on the server, so the agent
does not have to know any key format. R0.3 also listed C4 as the reader of
`branches` ("How R2 reads them" table).

## What the data says today

Local transcripts on this Mac, read-only, key names and counts only: 224
files, 49,636 lines. 26,956 lines carry `gitBranch`, always a string. 1,677
are `HEAD`. 30 distinct branch names. The upper-case key rule below matches
1 of them, at the start of the name. A case-insensitive rule matches 1 more:
a lower-case 5-letter word followed by a number, in the middle of the name.
That one is not a ticket, which is the false positive the rule must avoid.

Prod, read-only, 2026-11-23. 82 `claudeEnrichment` docs from 2 users. 1 doc
(1 user, 2026-11-21, the only 0.4 day) has `branches`: 9 branch rows on 1 of
its 2 projects. Branch cost is $28.75 of that project's $28.83; the gap is
`HEAD` time. 0 branch names match the key rule. 0 teams.

So the page ships empty in prod. It fills as devices move to agent 0.4+ and
as people on ticket branches sync. There is no history to backfill: days from
older agents have no branch rows.

## Scope

In:
- A pure function `ticketKey(branch, prefixes)` in the API.
- `GET /v1/dashboard/tickets`: ticket rows and project-key rows.
- An admin setting for allowed project keys, stored on the org.
- A Tickets section on `/projects`.
- `/privacy`: branches move from "none" to "scoped".

Out:
- Agent changes. No new wire field.
- Epics and ticket titles (needs Jira, Decision 6).
- Tokens per ticket (branch rows carry cost only, Decision 5).
- Per-person rows per ticket. The Projects page has none either.
- Codex, Gemini, Qwen and Copilot. Only Claude transcripts carry the branch.

## Extraction rule

```ts
// Jira key: letter, then 1-9 letters or digits, a dash, a number from 1.
const TICKET = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-([1-9]\d{0,6})(?!\d)/g
```

`ticketKey(branch, prefixes)`:
1. Run `TICKET` over the name. This finds keys at the start
   (`PROJ-123-fix`), after a slash (`feature/PROJ-123`), or after a dash or
   underscore.
2. Upper-case each match's prefix. Keep the first match whose prefix is in
   `prefixes`. Return `PROJ-123`, or null.

The allowlist does the false-positive work. `UTF-8`, `ISO-8601`, `SHA-256`,
`RFC-7231` and `release-1` all match the regex shape and are all dropped
because `UTF`, `ISO`, `SHA`, `RFC` and `RELEASE` are not allowed keys.
Matching case-insensitively is then safe, so `proj-123-fix` counts as
`PROJ-123`. The leading-zero rule drops `PROJ-0`. The 7-digit cap drops long
build or date numbers. Jira allows `_` in keys, but the rule leaves it out:
with it, `foo_PROJ-1` would match as `FOO_PROJ-1` and hide `PROJ-1`. Keys
with `_` are rare; add them if an org asks.

Without an allowlist the page cannot tell `UTF-8` from `ABC-8`. Decision 1
covers what the page does before an admin sets one.

## Data

One aggregation on `claudeEnrichment`, using `enrichmentMatch`
(`routes/dashboard/enrichment.ts:27-29`, index `{ orgId, date }`) and
`viewerScope`, as the Projects route does:

```ts
[
  enrichmentMatch(range),
  { $unwind: '$projectBreakdown' },
  { $unwind: '$projectBreakdown.branches' },
  { $group: {
      _id: { branch: '$projectBreakdown.branches.name',
             repo: { $ifNull: ['$projectBreakdown.remote', '$projectBreakdown.path'] } },
      cost: { $sum: '$projectBreakdown.branches.cost' },
      sessions: { $sum: '$projectBreakdown.branches.sessions' },
      users: { $addToSet: '$userId' },
      days: { $addToSet: '$date' },
  } },
]
```

Rows that cross the wire are distinct branch and repo pairs, which is small.
Node then runs `ticketKey` on each and folds by key: sum cost and sessions,
union users, count repos and days. Rows with no key are summed into one
"No ticket" line, so the ticket rows plus that line equal branch cost.
Raw branch names never leave this function.

Same pattern as A5: the DB narrows, a pure function decides. If an org grows
to thousands of branches a month, move the regex into the pipeline with
`$regexFindAll`.

Known limits, said once on the page footer:
- Sessions are summed across days and repos, as the Projects route does
  (`projects.ts:46`). A session that runs two days counts twice.
- A session that spans two branches counts in both. R0.3 measured 8 of 156.
- The agent sends the top 50 branches per project per day
  (`schemas.ts:60`). Branches below that are not counted.
- Cost is Claude Code, API-equivalent, like the rest of `/projects`.

Settings: `OrganizationDoc.ticketPrefixes?: string[]`. Absent means not set.
Each entry `^[A-Z][A-Z0-9]{1,9}$`, at most 50. No new collection, no index,
no migration. No schema sync: the wire schema does not change.

## API

`GET /v1/dashboard/tickets?from&to`

- Same `dateQuerySchema` and `viewerScope` as `/projects`. All roles; a
  developer sees their own branches only. No `auditView`, as `/projects` has
  none and no person is named.

```ts
interface TicketUsageResponse {
  from: string; to: string
  prefixes: string[] | null          // null: admin has not set any
  tickets: TicketRow[]               // sorted by cost, then key
  projectKeys: { prefix: string; tickets: number; cost: number; sessions: number; userCount: number }[]
  noTicket: { cost: number; sessions: number }
  /** Upper-case prefixes seen in range that are not allowed yet. Admin only. */
  suggestions: { prefix: string; branches: number }[] | null
}
interface TicketRow {
  key: string                        // PROJ-123
  cost: number; sessions: number
  userCount: number; repoCount: number; days: number
}
```

`suggestions` only counts upper-case matches (the stricter rule), so `phase-1`
style names do not show up. It returns prefixes and counts, never branch
names. Types go in `packages/shared/src/types.ts` next to
`OrgProjectSummary`.

`GET` and `PUT /v1/dashboard/tickets/settings`, admin only, body
`{ prefixes: string[] }`, empty array clears. Same shape as
`leaderboard.ts:394-402`, with `audit()` action `org.ticket_prefixes`.

## Dashboard

On `/projects`, under the project table, a `Tickets` section using the
existing `TableFrame`, `Th`, `Td`, `Tr`, `EmptyRow`. Same range bar, since
`/projects` is already range-scoped (`components/RangeBar.tsx:14`).

- Ticket table: Ticket, Value, Sessions, Users, Repos, Days. Top 50 by
  value, with a "Show all" link. Plain text keys, no links (no Jira base URL).
- Project key table: Key, Tickets, Value, Sessions, Users.
- Last row "No ticket": value spent on branches with no allowed key.
- No prefixes set: the section shows one line, "Set your Jira project keys
  in Admin to see usage per ticket." Admins also see the suggestions list.
- Admin page: a `TicketSettingsForm` next to `LeaderboardSettingsForm`.
  Comma-separated keys, validated, suggestions shown as hints.
- One footer line: "Claude Code only, from branch names. Agent 0.4 or later."

## Privacy

Branch names are already sent and stored since agent 0.4.0. C4 is the
first reader. Two changes follow:

- `transparency.ts:70` moves to `'scoped' // Projects (tickets)`, so
  `/privacy` says who can see derived data from branch names.
- The API returns ticket keys and prefix counts only. A branch name like
  `fix/acme-customer-leak` has no allowed key and only adds to "No ticket".

Sending only the key from the agent would reduce what is stored, but it ties
the agent to one key format and to each org's allowlist (R0.3 decision 8).
Decision 2 keeps that choice. If an org later wants raw names off the wire,
it is an agent option that rides the next agent minor after the 0.6.0
cutover (`tasks/AGENT-OWN-COLLECTOR-DESIGN-PART2.md`, phase 2). It would
live where the branch is read today (`codeburn.ts:270`), and the own
collector keeps reading `gitBranch` the same way
(`AGENT-OWN-COLLECTOR-DESIGN-PART1.md:78`), so the change stays compatible.

## Tests

- `ticketKey`: start, after slash, after dash or underscore; lower-case
  branch upper-cased; `UTF-8`, `ISO-8601`, `SHA-256`, `release-1`, `PROJ-0`,
  8-digit number all null; two keys, first allowed one wins; empty
  allowlist always null; `HEAD` never reaches it.
- Route: developer sees only self; manager sees managed teams; ticket in two
  repos is one row with `repoCount: 2`; ticket cost plus `noTicket` equals
  branch cost; `suggestions` null for non-admins; `prefixes: null` when unset;
  days from pre-0.4 agents (no `branches`) add nothing.
- Pipeline stage test in `enrichment-query.test.ts`, as for `projectTotals`.
- Settings: 403 for non-admin; bad key rejected; empty array unsets; audit
  row written.
- `transparency.test.ts` still passes with the new audience.
- Page test: both tables, "No ticket" row, unset-prefix message, admin hint.

## Release

Next web minor, `--latest=false` (memory: release per change). No agent
release, no schema sync, no migration.

## Decisions (open)

1. **Allowlist or any match.** Recommended: admin allowlist required, with
   upper-case prefixes seen in the data offered as one-click suggestions.
   Any-match with a built-in denylist (`UTF`, `ISO`, `SHA`, ...) shows data
   with no setup, but the denylist never ends and wrong tickets erode trust.
2. **What the agent sends.** Recommended: keep full branch names, parse on
   the server (R0.3 decision 8 stands). The API never returns raw names.
   The other choice, agent sends keys only, needs an agent release and a
   per-org config push to devices.
3. **Case.** Recommended: match case-insensitively, then require an allowed
   prefix. Upper-case only is stricter but misses `proj-123-fix`, a common
   hand-typed form.
4. **Where it shows.** Recommended: a section on `/projects`, same roles as
   that page. A new nav item is more visible but adds a page for one table.
5. **Tokens per ticket.** Recommended: cost and sessions only for now. Adding
   tokens means new optional fields on `BranchEntrySchema`, which rides the
   next agent minor after 0.6.0, and only fills from then on.
6. **Epics.** Recommended: out of scope. The project-key rollup covers "per
   Jira project". Epics, titles and status need a Jira integration
   (`OrgIntegrationDoc.provider` would gain `'jira'`); make it its own
   roadmap item if wanted.

## Steps

1. `ticketKey()` and its tests in `apps/api/src/routes/dashboard/`.
2. `ticketPrefixes` on `OrganizationDoc`; settings GET/PUT and tests.
3. Shared types.
4. `ticketTotals` pipeline, route, stage test, route tests.
5. `fetchTickets` and settings calls in `apps/dashboard/src/lib/api.ts`;
   Tickets section on `/projects`; `TicketSettingsForm` on Admin; page test.
6. `transparency.ts:70` audience to `'scoped'`.
7. Typecheck and all suites. Changelog, PR, merge, next web minor. Set a
   prefix on prod and check `/projects` signed in.
