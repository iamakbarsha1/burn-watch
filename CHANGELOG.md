# Changelog

Two release lines, tagged separately:

- **Web** (`web-vX.Y.Z`): dashboard and API. Deploys on merge to `main`.
- **Agent** (`vX.Y.Z`): the `burnwatch` binary. A `v*` tag builds the binaries,
  and `burnwatch update` installs them.

A feature bumps the minor version, a fix bumps the patch.

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
