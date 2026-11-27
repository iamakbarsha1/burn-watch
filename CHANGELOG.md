# Changelog

Two release lines, tagged separately:

- **Web** (`web-vX.Y.Z`): dashboard and API. Deploys on merge to `main`.
- **Agent** (`vX.Y.Z`): the `burnwatch` binary. A `v*` tag builds the binaries,
  and `burnwatch update` installs them.

A feature bumps the minor version, a fix bumps the patch.

## web-v2.0.0 (2026-11-27)

Breaking API change. The admin roster no longer carries usage.

- Admin: the Team table drops the Days, Tokens and Value columns and the
  Last sync column, and lists people by name. Status now reads Disabled,
  Not set up, Reporting, or Not reporting for 7+ days. That is enough to
  spot a broken agent without showing when each person was last active.
  The All-time value tile is now a Not reporting count. Org totals stay
  on Overview.
- API: `GET /v1/auth/admin/users` drops `lastSeenAt`, `lastSyncDate`,
  `totalCostUsd`, `totalTokens` and `activeDays`, and adds `reporting`
  (true when any of the person's devices submitted in the last 7 days).
  It sorts by name, not by cost. Before this, admins still had a cost
  ranking of named people, which broke v2 rules 1 and 3.
- CI: the no-individuals check now lists, for each allowlisted named
  route, the fields it may return. Any object that names someone else may
  carry only those keys, so a usage number next to a name fails the run,
  even on an admin route. Five fields that still sit next to names are
  listed in `KNOWN_FIELDS` as a ratchet: `lastSeenAt` on
  `/v1/auth/admin/devices`, and `days`, `tokens`, `firstDate`, `lastDate`
  on `/v1/dashboard/governance/setup-checks`.
- No migration. No schema sync.

## web-v1.2.0 (2026-11-27)

- Admin: a Delete button on each person in the Team table. After a
  confirm, it deletes the person and everything BurnWatch holds on them:
  usage events, daily snapshots, Claude Code enrichment, seats, team
  places, devices and their tokens, pending devices, invites and their
  login. Past org and team totals drop by their share.
- New route `DELETE /v1/auth/admin/users/:id`, admin only, in the caller's
  org. An admin cannot delete themselves, so an org always keeps an admin.
  Writes a `user.delete` audit action with how much was removed. Audit
  rows about the person stay; the audit log is never edited.
- No migration. No schema sync.

## web-v1.1.0 (2026-11-27)

v2.1: closes the gaps left after v2.

- An admin of an org with fewer than 5 active people now gets "group too
  small" for org totals, the same as a manager of a small team. An admin
  alone in the org still sees their own data. Unused seats and setup
  checks still name people to an admin, since they exist so an admin can
  act on one person. Adoption and Governance show them under the "group
  too small" notice.
- Who viewed my data now goes by who a view covered when it happened.
  Each view row stores the people it covered, so joining or leaving a team
  later no longer changes which views you see. Views from before this
  release have no such record and still go by the teams you are in today.
- API: `streak` on `GET /v1/dashboard/me/usage` is now `consecutiveDays`
  (same shape: `current`, `longest`, `lastActive`). My usage shows
  "Consecutive days".
- CI: the neutral-words check now covers the API and shared packages too.
- `/privacy` says the minimum group size applies to a whole org.
- No migration. No schema sync.

## web-v1.0.0 (2026-11-26)

v2: no micromanagement. Breaking: features are removed and API responses
change. BurnWatch now shows team-level Claude Code cost and adoption, and
each person gets a private view of their own usage. Plan and rules:
`tasks/V2-NO-MICROMANAGEMENT-PLAN.md`. The agent does not change.

Removed, and why:

- **Leaderboard and the 0 to 100 score** (`/users`, the leaderboard route,
  `SCORE_WEIGHTS`). Ranking people by AI use is the problem v2 fixes.
  Replaced by My usage (`/me`) for each person and a usage distribution
  for managers: how many people use it 0, 1 to 2, 3 to 4 or 5+ days a
  week, with no names.
- **Cost per person, value multiple, API spend per person.** These put a
  price on a person. Cost by org, team, project and ticket stays. Each
  person sees their own cost on My usage.
- **Streaks and active days in any manager or admin view.** That is
  presence tracking. Your own streak stays on My usage, visible only to
  you.
- **Leaderboard settings** (`developerView`, `showNames`, `showOthersCost`)
  and **"hide me on the leaderboard"** (`hideOnLeaderboard`). Nothing is
  left for them to control. Migration `0005_drop_leaderboard_settings`
  unsets the fields.
- **"Stuck" list on the adoption funnel.** It named people who use AI
  less. Stage counts per team stay.
- **Per-person onboarding status ("missed", "in progress").** It graded
  new hires pass or fail. Managers see cohort counts. New hires see their
  own first 14 days on My usage. The API state `missed` is now
  `windowEnded`.
- **Per-person feature grid.** Replaced by the share of a team that has
  used each feature.
- **Auto-picked champions.** They singled people out without asking.
  People now volunteer as "happy to help" from My usage.
- **Per-person budget alerts.** A personal spend cap reads as
  monitoring. Org and team budgets stay. Migration
  `0006_drop_per_person_alerts` deletes the old ones.
- **Named limit-hit alerts.** Replaced by a count of people who hit a
  usage limit, as a signal to raise limits. You see your own limit hits.
- **Named lists of personal accounts and free-tier use.** Admins see
  counts. You see a notice about your own account on My usage.
- **Per-server user list in the MCP inventory.** Replaced by a count of
  people.
- **"Last seen" on devices for managers.** Admins keep it for asset
  management.

Kept, renamed:

- Policy violations are now **setup checks**
  (`/governance/setup-checks`). Admins see names, since it is a security
  control. Managers see a count. You see your own checks on My usage.
- Idle seats are now **unused seats** (`/adoption/unused-seats`), admin
  only: name, seat, days since last use. You see your own seats.

Added:

- Groups under 5 people return "group too small" instead of numbers
  (`403 group_too_small`).
- **Who viewed my data** on My usage (`GET /v1/dashboard/audit/me`):
  views of the whole org, a team you are in, or your manager's teams, for
  the last 90 days.
- **What BurnWatch will never do** on `/privacy`.
- CI: "Neutral words" fails on ranking or blame words in the dashboard,
  and a real-MongoDB check fails if any response names another person
  outside the admin allowlist or answers for a group under 5.

Upgrade: run migrations 0005 and 0006
(`npm run sync -w @burn-watch/db`). Known gaps: an admin of an org under
5 people still sees org totals, and Who viewed my data goes by the teams
you are in today.

## Agent v0.6.0 (2026-11-23)

Own usage collector, cutover and cleanup. The agent now collects usage
itself. It no longer needs node or `npx`, and it no longer runs a
third-party tool.

- Usage events come from the agent's own Claude Code reader, bucketed by
  UTC day. Earlier agents used the laptop's local day.
- An upgraded device does not re-send days the previous collector already
  sent. On its first 0.6.0 sync it stores `ownCollectorFrom`, the UTC day
  of its last sync, and skips earlier days. A new device backfills as
  before. For a non-UTC user, a few hours around that one day are counted
  twice or not at all (5.5 hours for IST).
- Fix: a request whose streamed lines were written on both sides of
  midnight counted on the later day when only that day was synced. The
  earliest copy now decides the day. This was the 2026-11-22 mismatch in
  `burnwatch status` (211,255 tokens).
- Codex, Gemini CLI, Qwen and Copilot CLI are not collected from laptops
  until each has a parser. `burnwatch status` prints one line per tool:
  file count, "not found" or "not collected", plus the price table version.
- Sync warns when a model has no price. That model's rows are sent as
  `unpriced`, never as free.
- Removed: `burnwatch compare`, `--dump-shape`, the shadow comparison,
  `referenceDiff` in the upload, and `npxPath` in the config. Old config
  files that still have those keys keep working.

## web-v0.21.0 (2026-11-23)

- `/devices` shows "Update agent" for agents below 0.6.0, the first that
  needs no node. The version-fields threshold stays 0.4.0.
- The usage upload no longer takes `referenceDiff`. 0.5.x agents that
  still send it are accepted and the field is dropped. `/privacy` no
  longer lists it.
- Setup page and `docs/INSTALL.md`: backfill reads Claude Code logs
  directly; other tools are not collected from laptops yet.
- CI fails if the previous collector's name appears in the repo.
- No schema sync.

## web-v0.20.0 (2026-11-23)

R2 D5: recommended setup, MCP half.

- New "Recommended setup" cards in the "Top users vs rest" section on
  `/adoption`: one for the whole org (or all your teams), then one per
  team.
- Each card lists MCP servers used by at least half of its top users
  and champions, and by 2 or more of them. Servers are grouped as "Add
  to .mcp.json", "Install plugin" and "Connect in claude.ai". Unnamed
  servers are skipped.
- A copy button gives a plain-text checklist per card.
- Admins see a "not approved" badge once the org has approved any MCP
  server.
- Counts only, no names. Skill names need agent 0.6 or later and come in
  a later release.
- `GET /v1/dashboard/adoption/practices` gains `setup`. No schema sync,
  no agent release.

## web-v0.19.0 (2026-11-23)

R2 D6: onboarding score.

- New "Onboarding" section on `/adoption`, after Funnel, for admins and
  managers. It covers people whose first sync is in the date range.
- Onboarded means tokens on 2 or more days in each of their first two
  weeks, and 2 or more Claude Code features in their first 14 days.
- Per team: new, onboarded ("n of m", with a percentage from 5 finished
  windows), missed, in progress, and no feature data.
- Lists of people in progress and people who missed, with what each one
  still lacks.
- People with no Claude Code use in their 14 days are not scored.
- New route `GET /v1/dashboard/adoption/onboarding`. No schema sync, no
  agent release.

## web-v0.18.1 (2026-11-23)

Fix: `/privacy` now lists `skillCounts`, `sidechainMessages`,
`permissionModeCounts` and `entrypointCounts` as visible to your scope.
Adoption (Features, Top users vs rest, Suggested champions) has used
them since web-v0.14.0 to show who uses skills, subagents, plan mode
and the SDK, but the page said no one sees them.

## web-v0.18.0 (2026-11-23)

R2 A7: suggested champions.

- New "Suggested champions" block in the "Top users vs rest" section on
  `/adoption`. It shows the top 2 Claude Code users per team, ranked by
  the same "Rank by" picker, with the features they use and the ones
  they could help the team with.
- Teams need 3 or more Claude Code users. Admins also see a "No team"
  row.
- People who hid their name on the leaderboard are never suggested to
  managers. Admins see them with a note. When an org turns leaderboard
  names off, managers see no champions.
- A suggestion only. Nothing is stored and nobody is told.
- `GET /v1/dashboard/adoption/practices` gains `champions` and
  `namesOff`. No schema sync, no agent release.

## web-v0.17.0 (2026-11-23)

R2 A6: top users vs rest.

- New "Top users vs rest" section on `/adoption`, for admins and
  managers. It compares the top quarter of Claude Code users with
  everyone else on MCP, skills, subagents, plan mode, MCP servers and
  cache hit rate. No names.
- Rank by active days (default), Claude tokens or leaderboard score.
- Up to three fixed tips name the biggest gaps.
- Needs 4 or more Claude Code users in scope. Below that the section
  says how many it has.
- Cache hit rate is weighted by tokens from usage rows, not a mean of
  daily rates.
- New route `GET /v1/dashboard/adoption/practices`. No schema sync, no
  agent release.

## web-v0.16.0 (2026-11-23)

R2 C4: usage per ticket.

- New `/tickets` page in the nav, same roles and range as `/projects`.
  It shows Claude Code value, sessions, users, repos and days per Jira
  ticket, read from Git branch names, plus a rollup per project key and
  a "No ticket" row.
- Only keys an admin lists count, so names like `UTF-8` are never read
  as tickets. Matching ignores case, so `proj-123-fix` counts as
  `PROJ-123`. Admins set the keys on the page and see upper-case keys
  found in branch names as hints.
- The API returns ticket keys and counts only, never branch names.
  `/privacy` now shows branch data as visible to your scope.
- Needs agent 0.4 or later. New routes `GET /v1/dashboard/tickets` and
  `PUT /v1/dashboard/tickets/settings`. No schema sync, no agent release.

## web-v0.15.0 (2026-11-23)

R2 B6: Claude accounts on `/governance`.

- New Claude accounts section, admins only. It shows which Claude orgs
  and accounts people use with Claude Code, as labels like "Account 1".
  BurnWatch only stores hashes of the IDs and never shows them.
- The admin ticks which Claude org is the company's, picked from the
  orgs already seen. The one their own days use says "includes you".
- Per person: shared account (one account seen under 2 or more people),
  several accounts, days outside the company org, and, once seats are
  entered, seat with no company use or company use with no seat.
- A coverage line says how many Claude Code users have account data.
  The rest need agent 0.4 or later.
- `/privacy` now lists both hash fields as seen by admins.
- New routes `GET /v1/dashboard/governance/accounts` and
  `PUT /v1/dashboard/governance/claude-orgs`. No schema sync, no agent
  release.

## web-v0.14.0 (2026-11-23)

R2 A5: feature matrix per team.

- `/adoption` has a new Features section. For each team it shows how
  many Claude Code users used MCP, skills, subagents, plan mode and the
  SDK on at least one day in the range. A Per person list shows the days
  for each feature. Admins and managers only, same scope as the funnel.
- Most of it works on every agent version, because it reads tool calls
  the agent already sends. SDK use needs agent 0.4 or later, and people
  without it show a dash.
- People who chose "Hide my name" on the leaderboard show as Hidden to
  managers. Admins see names.
- New route `GET /v1/dashboard/adoption/features`. No schema sync, no
  agent release.

## Agent v0.5.1 (2026-11-23)

- First published build of 0.5.0. The v0.5.0 release job failed before
  it built any binaries, so no v0.5.0 download exists. The agent code is
  the same as v0.5.0; the release job now builds the shared package
  first.

## Agent v0.5.0 (2026-11-23)

Own usage collector, phase 1 (shadow). Usage events still come from the
old collector. The new one runs beside it on every sync, and its numbers
are only compared with the old ones.

- Sync runs the new collector on the same local days and prints a line
  for any day where the two differ: tokens must match exactly per model,
  cost within 0.5% (or $0.01 on a day under $2). The upload carries a
  small `referenceDiff` (per tool: tokens and cost from each collector),
  and `burnwatch status` shows the last result.
- `burnwatch compare --days N [--agent a]` checks the last N closed UTC
  days per day, tool and model, and exits 1 on a mismatch. On the build
  machine Claude matches exactly on every day it has (Nov 17 to 22), in
  UTC and in IST days.
- `burnwatch compare --dump-shape <agent>` prints the shape of an agent's
  local logs: key names, counts and value types, never values. Keys that
  look like ids or paths print as `<key>`. Use it to send us the format of
  Codex, Gemini CLI, Qwen or Copilot CLI logs.
- Claude enrichment now reads the same deduped requests as the new
  collector and prices each one. A project's and a branch's cost is the
  sum of its own requests, not a token share of the day, so a project on
  a cheaper model no longer carries more than its share. `callCount`
  counts requests only; usage-limit notices no longer add to it.
- Claude transcripts are also read from `CLAUDE_CONFIG_DIR` and
  `~/.config/claude/projects`, not only `~/.claude/projects`.
- Sync fetches the model price table from `GET /v1/prices` at most once a
  day and keeps the built-in one if that fails.

## web-v0.13.0 (2026-11-23)

- The usage upload takes an optional `referenceDiff` from agent 0.5.0.
  The API keeps the last one on the device, with its day. No page shows
  it; `/privacy` lists it as stored, not shown. It goes away when the new
  collector takes over.
- No schema sync.

## web-v0.12.0 (2026-11-23)

Groundwork for the agent's own usage collector (phase 0). Nothing reads
the new pieces yet, and no agent release is needed.

- `GET /v1/prices` serves a model price table: input, output, 5-minute
  and 1-hour cache writes, cache reads and the above-200k tier, per token.
  It comes from LiteLLM's price file at a pinned commit (`18fe30f`,
  2026-11-22) and covers 213 Anthropic, OpenAI, Gemini, Qwen and Copilot
  models. A model with no known price is left out, never listed at $0.
  The endpoint is public, sends the table version as its ETag and answers
  304 when the caller already has it.
- Usage events take an optional `unpriced` flag for a model with no known
  price. `/privacy` lists it. The server stores it only when true; such a
  row has cost 0, so it stays out of spend totals.
- The agent's usage collector is renamed inside the code. Its output is
  unchanged.
- No schema sync.

## Agent v0.4.2 (2026-11-23)

- Claude enrichment no longer counts a request more than once. Claude Code
  writes one transcript line per block of a streamed reply, each repeating
  the same usage, so callCount, written tokens, per-project and per-branch
  tokens (and with them the per-project cost split and overhead), cache
  figures, versions, entry points, skills and sidechain messages were about
  double. Each request now counts once, keyed on `message.id` and
  `requestId`, across all files including subagent transcripts. A line
  missing either id still counts on its own. Tool, shell and MCP counts
  count each tool call once by its id, which also drops tool calls a resumed
  session copied from an earlier file. Days are still bucketed by UTC date.
- Enrichment already stored for past days stays doubled until those days
  are sent again. The server replaces a user-day's enrichment on each
  submit, so `burnwatch sync --days N` on 0.4.2 corrects the last N days,
  as long as the transcripts for them are still on disk.

## web-v0.11.0 (2026-11-22)

- `/devices` (admins): Registered devices gains Claude Code and Agent
  columns. Both come from what the agent already reports, so no agent
  release is needed.
- Admins set a minimum Claude Code version above the table (plain
  `X.Y.Z`, Save or Clear). A device under it gets a "Below 2.1.0" badge.
  With no minimum, nothing is flagged for Claude Code.
- A device on an agent before 0.4.0 shows "Unknown" for Claude Code and an
  "Update agent" badge, with a link to the setup guide. Unknown is never
  counted as below the minimum. A 0.4 agent that saw no Claude Code use
  reads "No Claude Code use".
- A summary line counts active devices (live token, seen in the last 14
  days): how many run agent 0.4.0 or later, how many are below the
  minimum, how many are unknown. Revoked devices stay in the table but
  not in the counts.
- Setting or clearing the minimum is logged on `/audit`.
- One optional field on the org document. No prod schema sync.

## web-v0.10.1 (2026-11-22)

- `/users` with "Show cost": the per-agent value under Tokens is one line
  per agent instead of one long line, so the table is about 400px narrower
  (1645px to about 1260px with all five agents).
- `/audit`: org-level changes (leaderboard settings, seats assigned to all,
  CSV invites) name the org instead of showing its id. Rows written before
  this show "Organization".

## Agent v0.4.1 (2026-11-22)

- A repo macOS will not let the scheduled sync read (for example under
  `~/Desktop`) is no longer treated as "not a repo" in silence. It is still
  sent by folder name with no remote, and the sync prints one warning naming
  the blocked folder and the setting to change: System Settings > Privacy &
  Security > Files and Folders (or Full Disk Access). `burnwatch status`
  shows the warning from the last sync.

## web-v0.10.0 (2026-11-22)

- New admin-only Audit log page (`/audit`, sidebar entry for admins). It
  answers who changed what and who looked at whose data.
- Changes logged: device approve and revoke (admin and `burnwatch
  uninstall`), org bootstrap, user create, invites (single, CSV upload as
  one event, accept), teams (create, rename, delete, add or change a
  member's team role, remove a member), seats (set, remove, assign to
  all), budget alerts, agent policies, MCP approvals, leaderboard
  settings, and Copilot connect, disconnect and sync. No tokens, invite
  codes or device codes are stored in an event.
- Views logged: Leaderboard, Governance, Adoption, the admin people lists
  (users, devices, Copilot seats), team comparison, and Overview or
  Trends with a team filter, plus the audit page itself. One row per
  person, page, scope and UTC day, with a count. A read that shows only
  your own data is not logged. "Hide my name on the leaderboard" is never
  logged.
- Filters: kind (changes or views), person and area, with the page date
  range. View events expire after 365 days. Changes are kept until a
  retention period is picked (B9).
- `/privacy` says admins can see who opened views that include team or
  person data.
- Not logged: an org role edited by hand in Mongo. There is no endpoint
  that changes `users.role` yet; it is set at invite, bootstrap or user
  create, and those are logged.
- New `auditEvents` collection with two indexes. Run
  `npm run sync -w @burn-watch/db` against prod before the deploy, or
  `/health` answers 503.

## web-v0.9.0 (2026-11-22)

- Leaderboard (`/users`) now ranks by active days, not dollars. Columns:
  active days ("12 of 30"), score, current streak with the best below,
  agents and MCP servers tried (names on hover), tokens and sessions. The
  empty Cache hit column is gone. On "All time" the day count starts at
  the first usage day.
- Sort by active days (default), score, current streak, tokens or value.
  Ties share a rank. Score is 0-100: active days, current streak, tokens
  and features tried, each against the top person in the list, weighted
  40/30/20/10. Cost is not in the score.
- Streaks are all time. Weekends never break one, and today and yesterday
  never break the current one, since they are usually not synced yet.
- Cost is hidden by default. "Show cost" adds value, actual cost, multiple
  and per-agent value.
- Team picker, as on Overview and Adoption.
- Admin > Leaderboard: what developers see (own row, own row and rank, or
  the whole list), show names (off shows "Person 1, 2..."), and whether
  developers see cost on other people's rows. Defaults: own row, names on,
  others' cost off. The API withholds names and cost, not only the page.
- "Hide my name on the leaderboard" on `/users`: others see "Anonymous",
  admins still see the name. The row and rank stay.
- Two optional fields (`organizations.leaderboard`,
  `users.hideOnLeaderboard`), no validator. No schema sync needed.

## web-v0.8.0 (2026-11-22)

- Adoption page: new "Funnel" section below Idle seats. It counts people at
  each step, per team: invited, registered, first sync, active and power
  user. Each cell shows the count and the share of the previous step. The
  first sync cell also shows how many people linked a device.
- The funnel follows the page date range. Active means tokens on 2 or more
  days, power user on 5 of every 7 days, scaled to the range (22 of 30 days
  for a 30-day range). The line under the table names the numbers in use.
  A range that starts before the org's first usage day starts on that day
  instead, so "All time" does not push power user out of reach.
- Invited counts registered users plus unused invites, once per email. An
  unused invite sits in its invite team, else in "No team".
- A collapsed "Who is stuck" list shows everyone short of power user,
  grouped by where they stopped, with team and the date of their last step.
- Admins see the org with a "No team" row, managers their own teams.
- No new collection or index. No schema sync needed.

## web-v0.7.0 (2026-11-22)

- New Adoption page (admins and managers) with an "Idle seats" list: every
  paid seat with no tokens on its agent for 14 or more days. Each row shows
  who holds it, last used (or "never"), days idle, price per month and cost
  since last use. Longest idle first, with per-agent totals on top.
- Change the threshold with the days field on the page (1 to 365). Seats
  newer than the threshold are left out. Admins see the org, managers their
  own teams.
- With no seats entered, the page points admins to Admin > Seats.
- A tripped idle-seat budget alert links to the list.
- No new collection or index. No schema sync needed.

## web-v0.6.0 (2026-11-22)

- Governance page: new "Agent and model policy" section. Admins set a rule
  for each of the five agents: allowed, listed models only, or blocked.
  Model names match exactly, and the form shows the models seen in the range.
- Usage outside the policy is listed per person, agent and model, with the
  reason: agent blocked, agent not set, or model not listed. Agents with no
  rule are flagged until an admin sets one. Managers see their own teams'
  violations and the policy, read only.
- Admins see the number of violations in the last 30 days on the Governance
  nav item, in a banner on Governance, and in a line on Overview.
- New `agentPolicies` collection. Run `npm run sync -w @burn-watch/db` before
  deploy.

## web-v0.5.0 (2026-11-22)

- Governance page: new "MCP servers" section. It lists every MCP server name
  seen in Claude Code use, with where it came from (plugin, claude.ai
  connector, local config, or no readable name), who used it, calls, days and
  last seen. Each name shows approved or not approved.
- Admins approve or revoke each name from the page. Managers see their own
  teams' servers, read only. Names match exactly, so `Neon` and
  `claude_ai_Neon` are approved separately.
- New `mcpApprovals` collection. Run `npm run sync -w @burn-watch/db` after
  deploy.

## web-v0.4.0 (2026-11-22)

- New Governance page (admins and managers) with a free-tier usage list: who
  used a free-tier AI tool, on which model, on how many days and with how many
  tokens, per person and per team. Admins see the whole org, managers their own
  teams. Each row says why it was flagged: a free-tier agent (Qwen) or a model
  with no known price.
- Gemini on a personal Google login is not flagged yet (BW-43). The page says so.

## web-v0.3.0 (2026-11-22)

- Admin page: invite up to 200 people from a CSV (`email,role,team`). Each row
  gets its own link or its own error; one bad row does not stop the rest.
- An invite can carry a team. The new user joins it on accept, as manager when
  invited as manager.
- GitHub Copilot panel is labelled "Unverified": it has never run against a real
  Copilot Business org.

## web-v0.2.0 (2026-11-22)

- New "What BurnWatch knows about me" page at `/privacy` ("My data" in the
  sidebar). It lists every field the agent can send, read from the shared
  schema, and shows who can see each one: you, your team's manager, or admins.
  It also lists what is never collected.

## Agent v0.4.0 (2026-11-22)

- Sends repository names and normalised Git remotes, never absolute paths.
- New optional transcript fields: branches, Claude Code versions, entry points,
  skills, subagent messages, permission modes, hashed account IDs.
