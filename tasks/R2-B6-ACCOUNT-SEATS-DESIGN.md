# R2 · B6 Claude accounts vs seats: design

Status: built 2026-11-23 as web-v0.15.0. Decisions locked, all six as recommended. Roadmap: `tasks/ROLLOUT-ROADMAP.md`
R2. Builds on R0.3 (`tasks/R0.3-AGENT-PRIVACY-DESIGN.md`, decisions 6 and 7) for
the hashes and R0.1 (`tasks/R0.1-SEATS-DESIGN.md`) for seats. Follows B1 and B3
for the `/governance` page pattern.

## Goal

Admins see which Claude accounts their people use, without BurnWatch ever
holding a raw Claude ID. Three questions:

| Question | Signal |
|---|---|
| Is someone using a personal Claude account for work? | Their days carry a Claude org hash that is not the company's. |
| Is one Claude account shared by several people? | One account hash seen under two or more BurnWatch users. |
| Do accounts match seats? | People with a Claude seat vs people seen on the company's Claude org. |

The page answers with counts and labels ("Account 1", "Claude org 2"). It
never prints a hash.

## What exists today

The agent already sends both hash lists. They are stored and shown nowhere.
B6 needs no agent release and no schema change.

| Piece | Where | Today |
|---|---|---|
| Hashing | `apps/agent/src/collectors/codeburn.ts:133-142, 297-305` | `session-owner` records map `sessionId` to `accountUuid` and `organizationUuid` (`:169, :189-191`). Per day, the distinct IDs of that day's sessions go through `HMAC-SHA256(key = BurnWatch orgId)`, hex, at most 20. No `orgId`, no hashes. |
| Sent fields | `codeburn.ts:342-343` | `accountHashes`, `claudeOrgHashes`, agent 0.4.0+. |
| Wire schema | `packages/shared/src/schemas.ts:98-107` | Both `z.array(z.string().length(64)).max(20).optional()`, with `.describe()` text. |
| Stored copy | `packages/db/src/documents.ts:277-278`, write `packages/db/src/usage.ts:150-151` | `ClaudeEnrichmentDoc`, one doc per user per day, `null` before 0.4.0. Index `claudeEnrichment_org_date` (`packages/db/src/registry.ts:97-98`). |
| Seats | `documents.ts:143-151`, index `registry.ts:123` | `SeatDoc` per (user, agent). Claude seats have `agent: 'claude'`. |
| Seat routes | `apps/api/src/routes/dashboard/seats.ts:25-102` | Admin only (`requireAdmin`). |
| Governance routes | `apps/api/src/routes/dashboard/governance.ts:231-266` | Free-tier and MCP: admin or manager, `readScope` (`apps/api/src/plugins/jwt.ts:144`), `auditView(request, 'governance', scope, teamId)`. |
| Org setting pattern | `apps/api/src/routes/auth/device.ts:506-530`, field `documents.ts:35` | B5's `minClaudeVersion`: optional org field, admin `GET`/`PUT`, `$unset` when cleared, `audit()` on write. |
| Governance page | `apps/dashboard/src/app/(dashboard)/governance/page.tsx:85, 151, 250` | Sections: Free-tier usage, Agent and model policy, MCP servers. |
| Transparency registry | `apps/dashboard/src/lib/transparency.ts:52-85` | `AUDIENCE` map read by `/privacy`. Both hash fields are `'none'` (`:82-83`). The test fails on a schema field with no entry. |

The registry lives in `apps/dashboard/src/lib/transparency.ts`, not in
`packages/shared`. It reads field descriptions from the shared Zod schema,
so `/privacy` already lists both hashes with their `.describe()` text.

### What a personal account looks like

Every `session-owner` record carries an `organizationUuid`. On this Mac,
2,049 records, all with `accountUuid` and `organizationUuid`, none without
an org. A personal Pro or Max account is still a Claude org of its own.
So "has an org hash" says nothing. The signal is "org hash is not one of
ours", and that needs the company's own org hash on file.

### How the admin marks the company's org

The hash is keyed on the BurnWatch org id. Anyone who knows the raw
Claude org id and the BurnWatch org id can compute it. BurnWatch has the
second, never the first. Two ways to mark it without BurnWatch seeing the
raw id:

1. Pick from what was seen. The page lists each Claude org hash seen in the
   org as "Claude org 1, 2, ..." with people and days, and marks the one the
   admin's own days carry as "includes you". The admin ticks the ones that
   belong to the company. No raw id is typed anywhere.
2. Hash in the browser. The admin pastes the Claude org id; the page runs
   HMAC-SHA256 with Web Crypto, keyed on the org id it already has, and
   sends only the hex. The raw id never leaves the browser.

Option 1 needs no lookup by the admin and works the day hashes arrive.
Option 2 works before any 0.4 agent has synced, but the admin has to find
the id in Claude's settings (not verified where Claude shows it). See
Decision 1.

## What the data says today

Prod, read-only, 2026-11-23. 1 org, 6 users, 7 devices, 0 teams, 0 seats.

| Fact | Count |
|---|---|
| `claudeEnrichment` docs | 82, from 2 users, 2026-09-09 to 2026-11-21 |
| Docs with `accountHashes` (non-empty) | 1, dated 2026-11-21 |
| Docs with `claudeOrgHashes` (non-empty) | 1, same doc |
| Distinct account hashes / users per hash | 1 / 1 |
| Distinct Claude org hashes / users per hash | 1 / 1 |
| Hashes per day on that doc | 1 account, 1 org |
| Devices by agent version | 0.1.0: 4, 0.2.1: 1, 0.2.4: 1, 0.4.0: 1 |
| Seats | 0 |

So today the page would show one account, one org, nothing shared and no
seat comparison. Every flag needs more people on agent 0.4+ and seats
entered in Admin. The page must say how many Claude users have no hashed
day in range, or an empty list reads as "all clear".

## Scope

In:
- `GET /v1/dashboard/governance/accounts`, admin only.
- `PUT /v1/dashboard/governance/claude-orgs`, admin only: the set of
  Claude org hashes that are the company's.
- One optional org field for that set.
- New "Claude accounts" section on `/governance`.
- `AUDIENCE` for both hash fields moves from `'none'` to `'admin'`.

Out:
- Agent changes. Pairing each account with its org per session is a
  later agent change if day-level proves too coarse (Decision 4).
- Cost on personal accounts. Tokens are not split by account, and seat
  cost math (R0.1) stays as it is.
- Alerts, the nav violation count, and D4's anomaly flags. B6 shows facts
  on one page; it adds nothing to `governance/violations/count`.
- Manager access (Decision 2).
- Non-Claude agents: no other agent exposes an account id.

## Data

New optional field on `OrganizationDoc` (`documents.ts:26`), next to
`minClaudeVersion`:

```ts
/** R2 B6. Claude org hashes that are the company's. Absent = not set, no personal-account flags. */
ownClaudeOrgHashes?: string[]
```

No new collection, no index, no migration, no schema sync.

One query on `claudeEnrichment`, `{ orgId, date: { $gte, $lte } }` (uses
`claudeEnrichment_org_date`), optional `userId: { $in: scope }`. Project
`userId`, `date`, `accountHashes`, `claudeOrgHashes`. Plus the org's
`seats` with `agent: 'claude'` and the users in scope.

In Node, after the query:

- Per account hash: set of users, day count, first seen.
- Per org hash: set of users, day count, `ours`.
- Per user: distinct account hashes, days with any hash, days with an org
  hash not in `ownClaudeOrgHashes`, Claude seat yes or no.

At one doc per user per day this is small. If an org grows past a few
thousand docs per range, move the grouping into the pipeline.

Labels are ordinals by first seen, then by hash, inside the response:
"Account 1", "Claude org 1". They are only stable for one range. The org
list also needs a stable id for the PUT (Decision 3).

### Flags per person

| Flag | Rule | Shown when |
|---|---|---|
| Shared account | One of their account hashes is seen under 2+ users in range | Always |
| Outside org | 1+ day with an org hash not in `ownClaudeOrgHashes` | Company org set |
| Several accounts | 2+ distinct account hashes in range | Always |
| Seat, no company use | Claude seat, hashed days, none on a company org | Seats exist and company org set |
| Company use, no seat | Days on a company org, no Claude seat | Same |

Day-level limit: a day with two accounts and two orgs cannot say which
account was in which org. The person still gets "Outside org" for that day,
which is true for at least one session. On prod every hashed day has one
of each.

## API

`GET /v1/dashboard/governance/accounts?from&to&teamId`

- 403 unless admin. `readScope(request.user, teamId)` for the team filter,
  `scopeError`, `auditView(request, 'governance', scope, teamId)`.
- Range start clamped to the org's first usage day, as other routes do.

```ts
interface ClaudeAccountsResponse {
  from: string; to: string
  /** Claude Code users in scope with a day in range, and how many of those have a hashed day. */
  coverage: { users: number; hashed: number }
  companyOrgSet: boolean
  seatsEntered: number                 // Claude seats in scope
  orgs: { id: string; label: string; users: number; days: number; ours: boolean; includesYou: boolean }[]
  accounts: { label: string; users: number; days: number; shared: boolean }[]
  people: {
    userId: string; name: string; teamIds: string[]
    hashedDays: number; accounts: string[]   // account labels
    outsideOrgDays: number | null            // null when company org not set
    claudeSeat: boolean
    flags: ('shared' | 'outside-org' | 'several' | 'seat-no-use' | 'use-no-seat')[]
  }[]
}
```

`PUT /v1/dashboard/governance/claude-orgs`, body `{ ids: string[] }`
(empty clears, `$unset` as B5 does). Admin only. Each id must resolve to a
hash seen in the org's `claudeEnrichment`; unknown ids get 400. Writes
`audit()` with the count only, not the hashes. Same shape as
`/admin/device-settings` (`device.ts:516-530`).

Browser hashing (Decision 1, option 2) is not built. If added later, the
PUT would also accept `{ hashes: string[] }` of 64 hex chars.

Types go in `packages/shared/src/types.ts`, next to the governance types.

## Dashboard

New "Claude accounts" section on `/governance`, after Free-tier usage.
Admins only; managers do not see it. Uses the page's range and team picker,
and the existing `Section`, `TableFrame`, `Th`, `Td`, `Tr`, `EmptyRow`,
`Badge` (`governance/page.tsx:10`).

- Coverage line first: "Account data from 1 of 2 Claude Code users. The
  rest need agent 0.4 or later."
- Claude orgs table: label, people, days, "includes you", a checkbox for
  "company org", Save. Unset state says "Mark your company's Claude org to
  see personal-account use."
- People table: name, team, hashed days, accounts (labels), outside-org
  days, seat, flags as neutral badges ("Shared account", "Outside company
  org"). Sorted by flag count, then name. Rows with no flags fold under
  "Show all".
- Seat line when seats exist: "6 Claude seats. 5 people seen on the
  company org." With 0 seats it links to Admin, Seats.
- Wording stays factual. No "violation", no red. The roadmap's trust risk
  (`ROLLOUT-ROADMAP.md:248`) and D4's tone note (`:42`) apply.

`/privacy` changes through `AUDIENCE` only: both hash rows show "Admins".
Add a comment on each: `// Governance, as labels; the hash is never shown`.

## Tests

- Grouping helper (pure): shared account across two users; one user with
  two accounts; outside-org day only when the company set is non-empty;
  seat flags only with seats; `null` and `[]` hash fields count as not
  hashed; labels ordered by first seen.
- Route: 403 for manager and developer; team filter narrows people and
  orgs; range clamp; empty range; response JSON contains no 64-hex string
  except `orgs[].id` if Decision 3 keeps the hash there.
- PUT: admin only; unknown id 400; empty list unsets; audit row has no hash.
- `transparency.test.ts` still passes with the two entries at `'admin'`.
- Page test: coverage line, unset org state, flags render as badges, no
  section for a manager.

## Release

Next web minor, `web-vX.Y.Z` with `--latest=false` (memory: release per
change). No agent release, no schema sync, no migration.

## Decisions (locked 2026-11-23)

1. **How the admin marks the company org.** Pick from orgs seen, with
   "includes you" (option 1). Recommended: no raw id typed anywhere, no
   lookup, no crypto in the page. Browser hashing (option 2) can follow if
   an admin needs to set it before agents update.
2. **Who sees it.** Admin only. Recommended. Shared and personal accounts
   are a licensing question, and the roadmap says managers get
   monitoring-like views only after the transparency page. The other
   choice is admin and manager with `readScope`, like Free-tier.
3. **Org id in the API.** Return the hash as `orgs[].id`, admin only, never
   rendered. Recommended: simplest, and an HMAC of a random UUID cannot be
   reversed. The other choice is a server-side ordinal re-resolved on PUT,
   which breaks when a re-sync adds an older first-seen day.
4. **Pairing account to org.** Stay at day level now. Recommended: every
   hashed day on prod has one account and one org. If mixed days show up,
   a later agent can send `claudeAccounts: [{ account, org }]`.
5. **Default before the company org is set.** Show the orgs list and the
   shared-account flag, no outside-org flags. Recommended. Guessing the
   largest org would mislabel a small company where most people use
   personal accounts.
6. **Personal use and seat cost.** Leave R0.1 cost math alone. Recommended.
   Tokens are not split by account, so a personal-account share of cost
   would be a guess.

## Steps

1. `ownClaudeOrgHashes` on `OrganizationDoc`; shared response types.
2. Grouping helper and its tests in `apps/api/src/routes/dashboard/`.
3. `GET /governance/accounts` and `PUT /governance/claude-orgs` in
   `governance.ts`, route tests.
4. `AUDIENCE` entries to `'admin'`; transparency test.
5. `fetchClaudeAccounts` and a save action in the dashboard; Claude
   accounts section; page test.
6. Typecheck and all suites.
7. Changelog, PR, merge, next web minor with `--latest=false`. Check prod
   `/governance` signed in as admin: coverage line, one org, one account.
