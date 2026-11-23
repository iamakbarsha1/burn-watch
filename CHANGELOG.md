# Changelog

Two release lines, tagged separately:

- **Web** (`web-vX.Y.Z`): dashboard and API. Deploys on merge to `main`.
- **Agent** (`vX.Y.Z`): the `burnwatch` binary. A `v*` tag builds the binaries,
  and `burnwatch update` installs them.

A feature bumps the minor version, a fix bumps the patch.

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
