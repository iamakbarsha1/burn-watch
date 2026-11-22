# R1 · B8 Admin audit log: design

Status: built 2026-11-22 as web-v0.10.0 (decisions locked 2026-11-22). Roadmap: `tasks/ROLLOUT-ROADMAP.md` R1
(last R1 item). Follows A8 (`tasks/R1-A8-LEADERBOARD-DESIGN.md`), which left
"leaderboard settings get an audit event" and "per-person view logging" to
B8, and B2 (`tasks/R1-B2-AGENT-POLICY-DESIGN.md`), which left "history of
policy changes" to B8.

## Goal

Admins can answer two questions from one page:

1. Who changed what: device approvals and revokes, invites, team and role
   changes, seats, budget alerts, policies, MCP approvals, leaderboard
   settings, the Copilot connection.
2. Who looked at whose data: which manager or admin opened a view that shows
   other people's usage, for which team, on which day.

The roadmap moved B8 up for the second reason: once managers can see team
data, view logging should exist from day one. The log is append-only from
the API's side. Nothing in BurnWatch edits or deletes an event; only the TTL
does (Decision 4).

## What exists today

| Piece | Where | Today |
|---|---|---|
| Auth on handlers | `apps/api/src/plugins/jwt.ts:7-12` | `request.user` is the verified `JwtPayload`: `userId`, `orgId`, `role` (`device` / `admin` / `manager` / `developer`), `deviceId` on device tokens. No name or email. |
| Admin gate | `requireAdmin`, `jwt.ts:81-92` | Per route `preHandler`. Dashboard routes also pass `requireDashboardAuth` as a group hook (`routes/dashboard/index.ts:16`). |
| Read scope | `viewerScope` / `teamScope` / `readScope`, `jwt.ts:104-147` | Admin: whole org (`undefined`). Manager: self plus managed teams. Developer: `[self]`. A team filter goes through `teamScope` (403/404). |
| Org scoping | every handler | `orgId` from the JWT on every filter; another org's id answers 404 (e.g. `seats.ts:74-85`, `teams.ts:219-227`). |
| Collections | `packages/db/src/registry.ts:41-136` | One `COLLECTIONS` entry per collection, with its indexes. `IndexSpec` already supports `expireAfterSeconds` (`registry.ts:31`); `rateLimits_ttl` is the one TTL index today (`registry.ts:130-133`). |
| Schema check | `assertSchemaCurrent`, `packages/db/src/schema.ts:215` | Called by `/health` (`apps/api/src/build-server.ts:89`). A missing collection or index is drift, so `/health` answers 503 until `npm run sync -w @burn-watch/db` runs. A new collection needs a prod sync before deploy, as B2 and B3 did. |
| Migrations | `packages/db/src/migrations.ts` | Forward-only, for backfills. B8 needs none. |
| Test fake | `apps/api/src/mongo-store.fake.ts:19-60` | Builds members from `Object.keys(COLLECTIONS)` (`routes.test.ts:43`), so a new registry entry appears in tests with no extra edit. `failOn: 'auditEvents.insertOne'` simulates a failed audit write. |
| Runtime | `burn-watch-api` on Vercel | Serverless. A promise left running after the response can be frozen with the function and never land. |
| Existing "who" fields | `agentPolicies.updatedBy`, `mcpApprovals.approvedBy` | Last writer only. No history. |
| Notes in code | `leaderboard.ts:392`, `adoption.ts:269` | "Gets the same audit treatment ... once B8 lands"; "Read only, so no audit event". |

## Actions to log

Every admin or manager write in `apps/api/src/routes/**`, plus the user and
device steps that create access. Line numbers are the handler's
registration line. "Detail" is what goes in the event besides actor and
target.

### Devices and access (`routes/auth/device.ts`)

| Action | Route | Line | Actor | Target | Detail |
|---|---|---|---|---|---|
| `device.approve` | `POST /v1/auth/approve-device` | 207 | the signed-in user (always their own device: the filter matches their email, `device.ts:226-236`) | user (self) | `hostname`, `platform`, `pendingId` |
| `device.revoke` | `POST /v1/auth/admin/devices/revoke` | 481 | admin | device | `ownerId`, `hostname` |
| `device.self_revoke` | `POST /v1/auth/revoke-device` | 511 | device token (`burnwatch uninstall`) | device | none |
| `org.bootstrap` | `POST /v1/auth/admin/bootstrap` | 374 | the new admin | org | `orgName` |
| `user.create` | `POST /v1/auth/admin/users` | 432 | admin | user | `email`, `role: 'developer'` |

Not logged: `register-device` (162, unauthenticated, no actor yet),
`verify-device` (261, the agent polling; the human step is the approval),
`refresh` (346).

### Invites (`routes/auth/invites.ts`)

| Action | Route | Line | Actor | Target | Detail |
|---|---|---|---|---|---|
| `invite.create` | `POST /v1/auth/admin/invites` | 68 | admin | invite (email) | `role` |
| `invite.bulk` | `POST /v1/auth/admin/invites/bulk` | 91 | admin | org | `created: [{ email, role, team }]`, `failed: n` (one event per upload, Decision 6) |
| `invite.accept` | `POST /v1/auth/invites/accept` | 158 | the new user | user (self) | `role`, `teamId` (this is where an org role is first set) |

### Teams and team roles (`routes/dashboard/teams.ts`)

| Action | Route | Line | Detail |
|---|---|---|---|
| `team.create` | `POST /teams` | 189 | `name` |
| `team.rename` | `PATCH /teams/:id` | 202 | `name` (new; `findOneAndUpdate` returns the doc after the update, `packages/db/src/store.ts:68`) |
| `team.delete` | `DELETE /teams/:id` | 219 | none (label read before the delete) |
| `team.member_set` | `PUT /teams/:id/members/:userId` | 230 | `role: 'manager' \| 'member'`. Covers "added" and "role changed". |
| `team.member_remove` | `DELETE /teams/:id/members/:userId` | 257 | none |

**Org role changes have no endpoint.** `users.role` is set by invite
(`invites.ts:185`), bootstrap (`device.ts:401`) or `POST /admin/users`
(always `developer`, `device.ts:454`). Changing it means editing Mongo by
hand, which no API log can see. The dashboard reads the role once at sign-in
(`apps/dashboard/src/lib/session.ts:75`). Team role (`manager`/`member`) is
the only role change the API makes today. See Decision 7.

### Seats (`routes/dashboard/seats.ts`)

| Action | Route | Line | Detail |
|---|---|---|---|
| `seat.set` | `PUT /seats/:userId/:agent` | 48 | `agent`, `monthlyPriceUsd`, `startDate` |
| `seat.remove` | `DELETE /seats/:userId/:agent` | 74 | `agent` |
| `seat.assign_all` | `POST /seats/assign-all` | 89 | `agent`, `monthlyPriceUsd`, `startDate`, `created` |

### Budget alerts (`routes/dashboard/budget-alerts.ts`)

| Action | Route | Line | Detail |
|---|---|---|---|
| `alert.create` | `POST /budget-alerts` | 123 | the parsed body (type, limit, threshold, userId, agent) |
| `alert.update` | `PATCH /budget-alerts/:id` | 170 | the `values` patch actually applied |
| `alert.delete` | `DELETE /budget-alerts/:id` | 219 | none |

### Governance (`routes/dashboard/governance.ts`)

| Action | Route | Line | Detail |
|---|---|---|---|
| `policy.set` | `PUT /governance/agent-policy/:agent` | 357 | `agent`, `rule`, `models`, `note` |
| `policy.unset` | `DELETE /governance/agent-policy/:agent` | 379 | `agent` |
| `mcp.approve` | `PUT /governance/mcp-approvals` | 388 | `server`, `note` |
| `mcp.unapprove` | `DELETE /governance/mcp-approvals` | 403 | `server` |

### Leaderboard settings (`routes/dashboard/leaderboard.ts`)

| Action | Route | Line | Detail |
|---|---|---|---|
| `org.leaderboard_settings` | `PUT /leaderboard/settings` | 393 | `developerView`, `showNames`, `showOthersCost` |

Not logged: `PUT /leaderboard/me` (400). It is a person's own privacy
choice, not an admin action, and logging it would hand admins a list of who
hid themselves.

### Copilot integration (`routes/integrations/copilot.ts`)

| Action | Route | Line | Detail |
|---|---|---|---|
| `copilot.connect` | `PUT /v1/integrations/copilot/connection` | 207 | `org` only. Never the token, not even a prefix. |
| `copilot.disconnect` | `DELETE /v1/integrations/copilot/connection` | 303 | none |
| `copilot.sync` | `POST /v1/integrations/copilot/sync` | 314 | `day`, outcome counts from the handler's response |

Not logged: `POST /v1/usage/submit` (`routes/usage/submit.ts:26`). Device
data writes are the product's normal traffic, not admin actions.

## Views to log

### Which reads show other people's data

No dashboard read takes a `userId` filter. Other people's data reaches a
viewer in two ways: per-person rows, or a team aggregate.

| Surface | Route(s) | Line | Per person? |
|---|---|---|---|
| `leaderboard` | `GET /dashboard/leaderboard` | `leaderboard.ts:165` | Yes. Developers too in A8 `rank`/`full` mode (`leaderboard.ts:182-183`). |
| `governance` | `GET /governance/free-tier`, `/mcp`, `/violations` | `governance.ts:231, 254, 306` | Yes (rows per user, MCP users per server). |
| `adoption` | `GET /adoption/idle-seats`, `/funnel` | `adoption.ts:175, 270` | Yes (idle seats per person, who-is-stuck list). |
| `people` | `GET /v1/auth/admin/users`, `/admin/devices`, `GET /v1/integrations/copilot/seats` | `device.ts:418, 472`; `copilot.ts:523` | Yes (per-user cost, devices, Copilot seat activity). Admin only. |
| `team_compare` | `GET /teams/compare` | `teams.ts:115` | Team aggregates. |
| `overview`, `trends` | `GET /overview`, `GET /trends` with `teamId` | `overview.ts:144`, `trends.ts:78` | Team aggregate. Only logged when `teamId` is set. |

Not logged: `/activity` (`activity.ts:67`) and `/projects`
(`projects.ts:65`). Both sum the viewer's whole scope with no per-person or
per-team split. `/budget-alerts` GET (`budget-alerts.ts:46`) lists alert
rules, not usage. `/teams` (94) lists names and members only. Known limit: a
manager whose scope is one other person sees that person's totals on
Overview without a team filter; the `people` count in the event (below)
shows this.

### What counts as a view event

One event per **viewer + surface + scope + UTC day**. The scope is the team
id when a `teamId` is passed, else `all` (the viewer's whole scope: the org
for an admin, managed teams for a manager, the org for a developer in A8
`full` or `rank` mode).

Logged only when the scope reaches someone other than the viewer: admin
(scope `undefined`), a manager or developer whose resolved scope has more
than one id, or a widened developer leaderboard. A developer reading their
own row writes nothing. A 403 or 404 writes nothing.

Dedupe: the `_id` is
`view:${orgId}:${viewerId}:${surface}:${scopeKey}:${date}`, written with one
upsert: `$setOnInsert` the event, `$inc: { count: 1 }`, `$set: { lastAt }`.
The three Governance reads on one page load, a refresh, and a range change
all fold into the same doc. Volume at 50 users with 5 managers and 2 admins:
at most about 7 viewers × 7 surfaces × a few scopes, so under 100 docs a day
on a heavy day.

Target for a view: `{ type: 'team', id, label: teamName }` with a team
filter, else `{ type: 'scope', id: null, label: 'org' | 'managed teams' }`.
Detail: `{ people: scope.length }` when the scope is a list (already
computed, no extra read), `null` for an admin's whole org.

The audit page's own read is logged too, as surface `audit`.

## Data

`auditEvents` (new, in `packages/db/src/registry.ts` + `documents.ts`):

```ts
type AuditTargetType =
  | 'user' | 'device' | 'invite' | 'team' | 'seat' | 'alert'
  | 'agent' | 'mcp' | 'org' | 'integration' | 'scope'

interface AuditEventDoc {
  _id: string                 // newId() for actions; the dedupe key for views
  orgId: OrgId
  kind: 'action' | 'view'
  action: string              // 'team.member_set', 'view.governance', ...
  actorId: UserId
  actorRole: JwtPayload['role']
  target: { type: AuditTargetType; id: string | null; label: string | null }
  detail: Record<string, unknown> | null   // small, never secrets
  at: Date                    // views: first view that day
  lastAt: Date | null         // views only
  count: number               // 1 for actions; views per day
  expiresAt: Date | null      // TTL; null = kept (Decision 4)
}
```

`target.label` is a snapshot (email, team name, hostname, server key), so a
renamed team or a deleted invite still reads in the log. Actor names are
resolved at read time from `users` (users are deactivated, never deleted).
`action` is a string union in `packages/shared/src/types.ts`, not a free
string, so a typo is a compile error.

Indexes:

- `auditEvents_org_at`: `{ orgId: 1, at: -1 }`. The page reads one org,
  newest first, by range.
- `auditEvents_ttl`: `{ expiresAt: 1 }`, `expireAfterSeconds: 0`. The
  retention period lives in the per-doc `expiresAt`, not in the index, so
  B9 can change it with a code constant. Changing `expireAfterSeconds` on a
  live index would show as a conflicting index in `assertSchemaCurrent`.
  Docs with `expiresAt: null` never expire.

Prod needs `npm run sync -w @burn-watch/db` before the deploy, or `/health`
answers 503 (`build-server.ts:89`).

## The helper

One file, `apps/api/src/audit.ts`, two functions:

```ts
export async function audit(request: FastifyRequest, e: {
  action: AuditAction; target: AuditTarget; detail?: Record<string, unknown> | null
}): Promise<void>

export async function auditView(request: FastifyRequest, surface: AuditSurface,
  scope: UserId[] | undefined, team?: { id: TeamId; name: string }): Promise<void>
```

Rules:

- **Awaited, never throws.** Follows the write procedure below. A failed
  audit write never fails the action.
- **After the write succeeds, outside any transaction.** Called on the
  success path only, after `runInTxn` returns (`seats.ts:59, 77, 94`). Inside
  the transaction, an audit failure would roll back the real change, which
  is the opposite of what we want.
- **Actor from the JWT only:** `request.user.userId`, `orgId`, `role`. Never
  from the body.
- **No secrets in `detail`.** Copilot token, invite codes, device codes and
  JWTs never go in. The verification code in `approve-device` is left out
  too; `pendingId` identifies the attempt.
- `auditView` returns early when the scope is `[self]`, so callers do not
  repeat the rule.

Handlers change by one line each (two where a label must be read before a
delete).

### Write procedure (runtime-independent)

The API runs on Vercel today, but the stack may change. The procedure must
hold on any runtime: serverless functions, containers, or a long-running
Node process. So it never depends on a platform feature.

1. **Finish before the response.** The audit write completes before the
   handler returns. No work after the response: no unawaited promise, no
   in-memory buffer, no `waitUntil` or other platform hook. Serverless
   runtimes can freeze or kill the process once the response is sent, and
   a container can be stopped mid-flight. Awaiting is the only rule that is
   safe on all of them.
2. **Never fail the action.** `try { insert/upsert } catch (err) { ... }`.
   The real change already succeeded; the user gets their normal response.
3. **Fail loudly and recoverably.** On error, write one structured log line:
   `request.log.error({ msg: 'audit_write_failed', err, event }, ...)` with
   the full event (actor, action, target, detail, at). Any log store or
   drain (Vercel, Datadog, CloudWatch, stdout to a file) keeps it, so a lost
   event can be found and re-inserted by hand. No secrets reach this line
   because `detail` never holds them.
4. **One seam.** Only `apps/api/src/audit.ts` writes to `auditEvents`.
   Route handlers call `audit()` / `auditView()` and know nothing about how
   the write happens. Moving platforms, or moving to a queue, changes this
   one file and no call site.
5. **Upgrade path.** If log-only recovery is not enough (a compliance need,
   or failed writes show up in the logs), replace the insert inside
   `audit.ts` with a durable path: an outbox collection written in the same
   transaction as the change, drained by a worker, or a managed queue.
   Call sites stay the same. The code carries a comment:
   `shortcut: failed audit writes are only in logs, move to outbox/queue if
   any loss is unacceptable`.
6. **Test it.** Unit test: a rejected insert still returns the action's
   normal response and emits `audit_write_failed` with the event. Route
   test: the audit row exists when the response arrives (proves the write
   is awaited, not left running).

When the API moves to a new runtime, the checklist is: confirm logs from
step 3 are kept somewhere searchable, and run the step 6 tests. Nothing
else changes.

## API

`GET /v1/dashboard/audit` in a new `routes/dashboard/audit.ts`, registered in
`routes/dashboard/index.ts`. `requireAdmin`. Query:

- `from`, `to` (`dateRangeFields`), default last 30 days.
- `kind`: `action | view | all`, default `all`.
- `actorId` (uuid), optional.
- `action` prefix (`team.`, `device.`, `view.`), optional, from a closed list.
- `targetId`, optional: "everything that touched this team, user or device".
- `limit` 1..200 (default 100), `offset`.

One `find` on `{ orgId, at in range, ...filters }`, sort `at: -1`, then one
`users.find({ _id: { $in: actorIds }, orgId })` for names.

```ts
interface AuditRow {
  id: string
  at: string; lastAt: string | null; count: number
  kind: 'action' | 'view'
  action: AuditAction
  actor: { id: UserId; name: string | null; role: string }
  target: { type: AuditTargetType; id: string | null; label: string | null }
  detail: Record<string, unknown> | null
}
```

No write endpoints. Nothing can edit or delete an event through the API.

## Dashboard

- New page `apps/dashboard/src/app/(dashboard)/audit/page.tsx`, admin only:
  `getUserRole()` redirect like `admin/page.tsx:37-38`, and in `SidebarNav`
  a `{ href: '/audit', label: 'Audit log' }` entry filtered like `/admin`
  (`SidebarNav.tsx:67-71`). A separate page, not a section on `/admin`: that
  page already has 8 sections and 283 lines, and the log needs its own
  filters and paging.
- Add `/audit` to `RANGE_SCOPED` in `RangeBar.tsx:14` so the range bar drives
  `from`/`to`.
- Filters in the URL: kind (All / Changes / Views), person (select of org
  users from `fetchAdminUsers`), area (Devices, Invites, Teams, Seats,
  Alerts, Governance, Leaderboard, Copilot, Views).
- Table: When (local time; views show "first 09:12, 4 times"), Who (name,
  role badge), What (plain sentence from `action` + `detail`, e.g. "Made
  Priya a manager of Platform", "Viewed Governance for Platform (6
  people)"), Target. "Load more" via `offset`.
- One formatter `auditSentence(row)` in `apps/dashboard/src/lib/audit.ts`,
  unit tested, so the table stays dumb.
- `/privacy` ("My data") gets one line: "Admins can see a log of who opened
  views that include team or person data." Trust risk from the roadmap.

## Tests

- `audit.ts`: inserts with actor from the JWT; swallows and logs an insert
  error (`failOn: 'auditEvents.insertOne'`); `auditView` skips a `[self]`
  scope; builds the dedupe `_id` from viewer, surface, scope and UTC day;
  uses `$setOnInsert` / `$inc` / `$set` with `upsert: true`.
- Route tests (`routes.test.ts`), per action group: a successful write
  records one event with the right `action`, target and actor; a 400, 403 or
  404 records none; with `failOn: 'auditEvents.insertOne'` the action still
  answers 2xx; seats record after the transaction, not inside it; Copilot
  `detail` never contains the token.
- Views: admin leaderboard read records `view.leaderboard`; a developer in
  `own` mode records nothing; a manager's `teamId` read records the team;
  a 403 team read records nothing; three Governance reads use one `_id`.
- `GET /audit`: developer and manager 403; filters build the expected
  `find`; another org's events never match (orgId on every filter); names
  come from one `users.find`.
- `schema.test.ts`: registry has `auditEvents` with both indexes and the TTL.
- Dashboard: `auditSentence` per action; `SidebarNav` shows "Audit log" to
  admins only; page redirects non-admins.

## Release

Web feature: next web minor (web-v0.10.0), CHANGELOG, tag with
`--latest=false`. **Prod schema sync for `auditEvents` before the merge.**
Smoke test: change a leaderboard setting, open `/governance` twice, then see
one action and one view (count 2) on `/audit`.

## Scope

In: the collection and helper, every action in "Actions to log", view
events for the surfaces in "Views to log", `GET /audit`, the `/audit` page,
the `/privacy` line.

Out (named, not built):

- An org role change endpoint (Decision 7).
- Developers seeing who viewed their data. Fits the transparency page later.
- Alerts or digests on audit events. Wait on a notification channel.
- CSV export. Easy later from the same query.
- Logging failed or refused attempts (403s). Rate limits and logs cover
  abuse today.
- Before/after diffs. The log shows the new value; the previous event shows
  the old one.

## Decisions (locked 2026-11-22)

All nine accepted as recommended. Number 8 is extended: the write must
follow a procedure that does not depend on Vercel (see "Write procedure").


1. **Log views by admins too, or managers only?** Recommend: everyone who
   sees beyond themselves, admins included. The dedupe keeps it to one row
   per admin per surface per day, and "who watches the admins" is the
   question an audit log exists to answer.
2. **Log developer views in A8 `full`/`rank` mode?** Recommend: yes, as
   `view.leaderboard` with scope `org`. Those developers see other people's
   rows; the rule "logged when the scope reaches someone else" covers it with
   no special case.
3. **Dedupe window: per UTC day, or every view?** Recommend: per viewer +
   surface + scope + UTC day with a count. Every view would multiply rows by
   page loads and range changes and hide the signal.
4. **Retention while B9 is undecided.** Recommend: views expire after 365
   days (`expiresAt = at + 365d`), actions keep `expiresAt: null` until B9
   picks a period. The TTL index ships now, so B9 only changes a constant
   plus a one-off backfill of `expiresAt` on old actions.
5. **Page or section?** Recommend: a separate admin-only `/audit` page with
   a sidebar entry. `/admin` is already long, and the log needs its own
   filters and paging.
6. **Bulk invite: one event per upload or one per invite?** Recommend: one
   `invite.bulk` event with the created list in `detail` (200 rows at most,
   about 12 KB). One upload is one admin decision; 200 rows would bury it.
   `targetId` search will not find an invitee by email inside it; the email
   filter can search `detail.created.email` if that turns out to matter.
7. **Org role changes.** No endpoint changes `users.role` today; it is fixed
   at invite. Recommend: keep B8 to logging what exists, and add
   `PATCH /admin/users/:id/role` as its own small item that calls `audit()`
   on day one. Until then, note in the CHANGELOG that a role edited in Mongo
   by hand is not in the log.
8. **Awaited or fire-and-forget.** Decided: awaited inside try/catch,
   following the runtime-independent write procedure above, so it holds on
   Vercel or any later platform. The cost is a few milliseconds on admin
   writes and on the first view of the day.
9. **Log `copilot.sync`?** It is an admin click but also a routine one.
   Recommend: yes. It writes usage for the whole org, and the outcome counts
   help when a sync goes wrong.

## Steps

1. `AuditEventDoc` in `documents.ts`, registry entry with both indexes,
   `schema.test.ts`. Shared types: `AuditAction`, `AuditSurface`,
   `AuditRow`, query schema.
2. `apps/api/src/audit.ts` (`audit`, `auditView`) with unit tests.
3. Wire actions, one route file at a time, each with its route tests:
   device + invites, teams, seats, budget alerts, governance, leaderboard
   settings, Copilot.
4. Wire views in the six surfaces; route tests for the scope rules and the
   dedupe key.
5. `GET /v1/dashboard/audit` with tests.
6. Dashboard: `fetchAuditLog`, `/audit` page, `auditSentence` with tests,
   `SidebarNav` entry, `RANGE_SCOPED`, `/privacy` line.
7. Typecheck + tests, PR, CI.
8. Prod schema sync (`npm run check` then `npm run sync -w @burn-watch/db`),
   merge, release web-v0.10.0, smoke test.
9. Roadmap: B8 done, R1 done. CHANGELOG.

Size: S–M. One collection, one helper, about 30 one-line call sites, one
read route, one page.
