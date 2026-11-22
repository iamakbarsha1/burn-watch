# R2 · B5 Agent and Claude Code versions per device: design

Status: decisions locked 2026-11-22, not built. Roadmap: `tasks/ROLLOUT-ROADMAP.md` R2
(first R2 item). Follows B3 (`tasks/R1-B3-MCP-INVENTORY-DESIGN.md`) for the
"admin sets it on the page" pattern and B8 (`tasks/R1-B8-AUDIT-LOG-DESIGN.md`)
for audit events.

## Goal

Admins see, per device, which Claude Code version and which BurnWatch agent
version it runs. Devices below an admin-set minimum Claude Code version are
flagged. Devices on an agent older than 0.4.0 are flagged too, because R2
"starts once a meaningful share of devices run v0.4" and this page is where
that share is counted.

Org fact #5 (minimum supported Claude Code version) stops being a blocker:
an admin types the minimum on the page, the same way B3 removed org fact #3.
With no minimum set, nothing is flagged for Claude Code and the agent
column still works.

## What exists today

Both versions are already stored on the device. B5 needs no agent release.

| Piece | Where | Today |
|---|---|---|
| Claude Code version, per message | `apps/agent/src/collectors/codeburn.ts:211` | `tally(b.claudeVersions, entry.version)`: assistant messages per Claude Code version, per day. |
| Shared schema | `packages/shared/src/schemas.ts:86` | `claudeVersions: countMap.optional()`, "Agent 0.4.0+". Not on `UsageEventSchema`; it lives on `ClaudeEnrichmentSchema`. |
| Per-day copy | `packages/db/src/documents.ts:263` | `ClaudeEnrichmentDoc.claudeVersions`. Keyed per user per day, so two devices overwrite each other. Not used by B5. |
| BurnWatch agent version | `apps/agent/src/version.ts:10` | `AGENT_VERSION = '0.4.0'`. Sent at register (`commands/register.ts:64`, required by `schemas.ts:119`) and on every submit from 0.4.0 (`commands/sync.ts:139`, optional in `schemas.ts:112`). |
| Version compare | `apps/api/src/routes/usage/submit.ts:18-22` | `highestVersion()`: `localeCompare(..., { numeric: true })`, so `2.1.330` beats `2.1.99`. Tested at `routes/routes.test.ts:1821-1824`. |
| Device write | `submit.ts:125-137` | After the commit: `$set` `lastSeenAt`, `agentVersion` (if sent), `claudeVersion` = `highestVersion` of that submit (if any). |
| Device doc | `packages/db/src/documents.ts:55-57` | `agentVersion: string`, `claudeVersion: string \| null` ("Null until a 0.4.0 agent submits"). New devices start with `claudeVersion: null` (`routes/auth/device.ts:322`). |
| Admin device list | `routes/auth/device.ts:123-152`, route at `:493-499` | `adminDevicesPipeline` projects id, hostname, platform, lastSeenAt, owner, revoked. No version fields. Already calls `auditView(request, 'people', undefined)` at `:497`. `requireAdmin`. |
| Row type | `packages/shared/src/types.ts:280-288` | `AdminDeviceRow`, no version fields. |
| Device page | `apps/dashboard/src/app/(dashboard)/devices/page.tsx:20-22, 40` | "Registered devices" table, rendered for admins only. Sidebar entry `SidebarNav.tsx:12`. |
| Org settings precedent | `documents.ts:33`, `routes/dashboard/leaderboard.ts:395-404` | A8 stores `leaderboard?: LeaderboardSettings` on the org doc, `PUT` is `requireAdmin`, then `audit()` with `org.leaderboard_settings`. No schema sync. |

### Freshness

`devices.claudeVersion` is the highest Claude Code version in the **last
submit**, not across all time. The default sync sends yesterday
(`commands/sync.ts:52`), so it lags by about a day. Ranges go oldest first
(`sync.ts:23-31`), so the last submit is the newest day. One gap: a manual
`burnwatch sync --date <old day>` (`sync.ts:50`) can set it back to an older
version until the next normal sync. See Decision 5.

### What "unknown" means

- **Agent before 0.4.0:** it never sends `agentVersion` on submit or any
  `claudeVersions`. `agentVersion` is the value from sign-in, and
  `claudeVersion` is missing. Because any 0.4.0 submit overwrites
  `agentVersion`, a stored value below 0.4.0 means the device has not
  submitted from 0.4.0 or later. That is the R2 gate signal.
- **Field absent vs null:** devices registered before R0.3 have no
  `claudeVersion` field at all. The pipeline must read it with
  `$ifNull: ['$device.claudeVersion', null]`.
- **Agent 0.4.0+ but `claudeVersion` null:** the device syncs but no Claude
  Code messages were seen (Codex, Gemini or Qwen only). Show "No Claude Code
  use", not "unknown".

## What the data says today

Prod, read-only query, 2026-11-22. 7 devices, all with a live token.

| agent | Claude Code | last seen |
|---|---|---|
| 0.4.0 | 2.1.330 | 2026-11-22 |
| 0.2.4 | field absent | 2026-11-19 |
| 0.2.1 | field absent | 2026-11-14 |
| 0.1.0 | field absent | 2026-11-06 |
| 0.1.0 | field absent | 2026-11-05 |
| 0.1.0 | field absent | 2026-11-05 |
| 0.1.0 | field absent | 2026-06-23 |

So: 1 of 7 devices on agent 0.4, 1 of 3 active in the last 14 days. One
Claude Code version is known. R2 has not started by the roadmap's own rule,
and this page is how we will see it start.

## Scope

In:
- `AdminDeviceRow` gains `agentVersion` and `claudeVersion`.
- Org setting `minClaudeVersion`, admin only, set on `/devices`.
- `GET` / `PUT /v1/auth/admin/device-settings`.
- Audit action `org.min_claude_version`.
- `/devices`: two new columns, flags, a summary line, the minimum form.
- `compareVersions` moved to `packages/shared`, next to `highestVersion`.

Out (named, not built):
- Manager access to the device list (Decision 3).
- Nudges, emails or alerts to people below the minimum.
- A per-device version history or a "versions over time" chart.
- Blocking old versions. BurnWatch reports; it cannot stop Claude Code.
- An admin-set minimum agent version (Decision 2).
- A count on the sidebar badge.
- Versions for Codex, Gemini, Copilot or Qwen. The agent does not collect them.

## Data

`OrganizationDoc` gains one optional field (`packages/db/src/documents.ts`):

```ts
/** R2 B5. Absent = no minimum, nothing flagged for Claude Code. */
minClaudeVersion?: string
```

Optional field, no index, so **no prod schema sync** (`assertSchemaCurrent`
checks collections and indexes only). Same as A8's `leaderboard`.

No change to `DeviceDoc`. No migration.

## API

### `GET /v1/auth/admin/devices` (existing)

`adminDevicesPipeline` (`device.ts:123`) adds to its `$project`:

```ts
agentVersion: '$device.agentVersion',
claudeVersion: { $ifNull: ['$device.claudeVersion', null] },
```

`AdminDeviceRow` gains `agentVersion: string` and `claudeVersion: string |
null`. The response stays an array, so the existing contract and the
`auditView('people')` call at `device.ts:497` are unchanged. That call
already logs admins viewing other people's devices. No new view event.

### `GET` / `PUT /v1/auth/admin/device-settings` (new, `device.ts`)

Next to the other `/admin/devices*` routes. Both `requireAdmin`.

- `GET` returns `{ minClaudeVersion: string | null }`, read from the
  caller's org (`orgId` from the JWT). No `auditView`: it returns one
  version string, no one's data.
- `PUT` body `DeviceSettingsSchema` in `packages/shared/src/schemas.ts`:

  ```ts
  export const DeviceSettingsSchema = z.object({
    minClaudeVersion: z.string().regex(/^\d+\.\d+\.\d+$/).max(20).nullable(),
  })
  ```

  A value does `$set`, `null` does `$unset`. Then
  `audit(request, { action: 'org.min_claude_version', target: { type: 'org',
  id: orgId, label: null }, detail: { minClaudeVersion } })`, after the
  write, as at `leaderboard.ts:397-402`. Returns the body.

### Shared types

- `AuditAction` (`packages/shared/src/types.ts:647-675`) gains
  `'org.min_claude_version'`. The `org.` prefix is already in
  `AUDIT_ACTION_PREFIXES`, so the audit page filter needs no change.
- `DeviceSettings` response type.
- `AGENT_FIELDS_VERSION = '0.4.0'` constant (Decision 2).

### Version compare

Move `highestVersion` out of `submit.ts:18-22` into `packages/shared` and
split out the compare it already does:

```ts
export const compareVersions = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })
export function highestVersion(versions: Record<string, number> | undefined): string | null
```

`submit.ts` imports it from shared. Behaviour unchanged; the test at
`routes.test.ts:1821` keeps passing. The dashboard imports
`compareVersions` (it already imports runtime values from shared, e.g.
`AUDIT_ACTION_PREFIXES` in `audit/page.tsx:3`).

## Dashboard

`/devices` (`apps/dashboard/src/app/(dashboard)/devices/page.tsx`), admin
part only. Not `/governance`: that page is range-scoped with a team filter,
and a device's current version has neither. Not `/admin`: it has 8 sections
and 283 lines, the reason B8 got its own page.

- **Minimum form**, above the table: one text input ("Minimum Claude Code
  version, e.g. 2.1.0") with Save and Clear. A client form posting to a
  server action in `devices/actions.ts`, same shape as
  `LeaderboardSettingsForm`. `revalidatePath('/devices')`.
- **Summary line** over active devices (live token, seen in the last 14
  days, A1's default): "Agent 0.4+: 1 of 3 active devices. Below the Claude
  Code minimum: 0. Unknown: 2." With no minimum set, the middle part reads
  "No minimum set".
- **Two columns** in "Registered devices":
  - Claude Code: the version, plus a `warn` badge "Below 2.1.0" when under
    the minimum. "Unknown (agent before 0.4)" when the agent is old. "No
    Claude Code use" when the agent is 0.4+ and the version is null.
  - Agent: the version, plus a badge "Update agent" when below
    `AGENT_FIELDS_VERSION`. A short note under the table links `/setup` for
    the rebuild steps.
- One pure helper `deviceVersionStatus(row, min)` in
  `apps/dashboard/src/lib/versions.ts` returns `{ claude: 'ok' | 'below' |
  'unknown' | 'none', agentOld: boolean }`. The summary and the badges both
  use it, so the table stays dumb.
- Revoked devices keep their row but are left out of the summary counts.
- `fetchDeviceSettings` / `updateDeviceSettings` in `lib/api.ts`.
- `auditSentence` (`apps/dashboard/src/lib/audit.ts`) gets a case: "Set the
  minimum Claude Code version to 2.1.0" or "Cleared the minimum Claude Code
  version". Without it the `default` branch at `:103` prints the raw action.

## Tests

- Shared: `compareVersions` (`2.1.330` > `2.1.99`, equal, `2.10.0` >
  `2.9.9`); `highestVersion` moved with its cases.
- API (`routes.test.ts`):
  - `GET /admin/devices`: fixture rows gain the two fields; the pipeline
    `$project` reads `claudeVersion` through `$ifNull`.
  - `GET /admin/device-settings`: developer, manager, device 403; `null`
    when the field is absent; org from the JWT, not the query.
  - `PUT`: 403 for non-admins; `"2.1"`, `"latest"`, `"2.1.0-beta"` give
    400; a value `$set`s, `null` `$unset`s; one `org.min_claude_version`
    event with the value; with `failOn: 'auditEvents.insertOne'` it still
    answers 200.
  - Submit: unchanged test at `:1821` still green after the move.
- `scripts/dashboard-pipelines.ts` (local Mongo, `adminDevices` at `:815`):
  expected rows gain `agentVersion` and `claudeVersion`, with one device
  inserted without a `claudeVersion` field to prove `$ifNull` gives `null`.
- Dashboard: `deviceVersionStatus` for each case (below, equal, above, no
  minimum, old agent, 0.4 with null version, revoked left out of counts);
  `auditSentence` for set and clear.

## Release

Web feature: web-v0.11.0, CHANGELOG, tag `web-v0.11.0` with
`--latest=false`. No agent release (0.4.0 already sends both versions). No
prod schema sync. Smoke test on prod: set the minimum to `2.1.0`, see one
device OK and the rest unknown with "Update agent", then see the change on
`/audit`.

## Decisions (locked 2026-11-22)

All eight accepted as recommended.

1. **Show Claude Code version, agent version, or both?** Recommend: both.
   Claude Code version is B5's stated purpose; agent version is the R2 gate
   and the reason most rows are unknown today (6 of 7). Showing only Claude
   Code would leave six blank cells with no next step.
2. **Agent minimum: admin-set or fixed?** Recommend: a fixed constant
   `AGENT_FIELDS_VERSION = '0.4.0'` in shared. It is a technical fact (the
   version that sends the fields), not an org policy. Raise it in code when
   a later agent adds fields R2 needs.
3. **Who sees it?** Recommend: admins only, like the existing device list
   (`requireAdmin`, `device.ts:493`). Managers can be added later through
   `readScope` if they need to chase their own team; that would also need a
   team filter and its own `auditView`.
4. **Unknown devices and the minimum.** Recommend: never count "unknown" as
   "below". Show it apart with the "Update agent" badge. Calling it below
   would claim a fact we do not have.
5. **The `--date` backfill can lower `claudeVersion`.** Recommend: accept
   and note it. It needs a manual sync of an old day and fixes itself on the
   next normal sync. Making the field only go up would hide a real
   downgrade. Revisit if it shows up in practice.
6. **Where the setting lives.** Recommend: optional `minClaudeVersion` on
   the org doc, with its own `GET`/`PUT /admin/device-settings`, mirroring
   A8. It keeps the `GET /admin/devices` array contract and needs no schema
   sync. The cost is a second fetch on `/devices`.
7. **Version format.** Recommend: only `X.Y.Z` digits for the minimum.
   Claude Code reports plain versions (`2.1.330` today). Pre-release tags
   can be allowed if one ever appears in the data.
8. **Org fact #5.** Recommend: closed by this design. Admins set the minimum
   on `/devices`; until they do, Claude Code is not flagged. Update the
   roadmap's fact list to say so, as B3 did for fact #3.

## Steps

1. Shared: move `highestVersion`, add `compareVersions`, `AGENT_FIELDS_VERSION`,
   `DeviceSettingsSchema`, `DeviceSettings`, `AdminDeviceRow` fields,
   `'org.min_claude_version'`. Tests.
2. db: `minClaudeVersion?` on `OrganizationDoc`.
3. API: `submit.ts` imports from shared; `adminDevicesPipeline` projects
   the two fields; `GET`/`PUT /admin/device-settings` with `audit()`. Route
   tests; `dashboard-pipelines.ts` on local Mongo.
4. Dashboard: `lib/versions.ts` + tests, `lib/api.ts` fetchers, server
   action, minimum form, columns, summary line, `/setup` link,
   `auditSentence` case + test.
5. Typecheck + full test suite, PR, CI, merge.
6. Release web-v0.11.0 (`--latest=false`), smoke test on prod.
7. Roadmap: B5 built, fact #5 closed, R2 gate share noted. CHANGELOG.

Size: S. One optional field, two small routes, one pipeline change, one
helper, two table columns.
