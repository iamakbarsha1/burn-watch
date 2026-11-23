# R2 · D5 Recommended shared `.claude/` set per team: design

Status: draft 2026-11-23, decisions open. Roadmap: `tasks/ROLLOUT-ROADMAP.md`
R2, row D5 ("Recommended shared `.claude/` MCP + skills set per team").
Builds on A6 (`tasks/R2-A6-TOP-QUARTILE-DESIGN.md`) for the top quartile
and B3 (`tasks/R1-B3-MCP-INVENTORY-DESIGN.md`) for MCP sources and
approvals.

## Goal

For each team, list the MCP servers and skills that the team's top users
share, so a lead can add them to the repo's `.claude/` folder and
`.mcp.json` once instead of each person finding them alone.

MCP servers can ship now. Skill names cannot: the data does not carry them
(see below). This doc covers both and splits the release.

## What exists today

| Piece | Where | Today |
|---|---|---|
| MCP servers per person | `apps/api/src/routes/dashboard/leaderboard.ts:147-155` | `mcpServersPipeline`: distinct `mcpUsage` keys per user in range. |
| MCP inventory | `routes/dashboard/governance.ts:197-213, 256` | `mcpInventoryPipeline`, `GET /governance/mcp`: calls, users, days per server. |
| MCP source | `governance.ts:219-224` | `plugin_` prefix = plugin, `claude_ai_` = claude.ai connector, UUID = unnamed, else local. The agent sends the name only, never a URL or command (`governance.ts:217`). |
| Approvals | `governance.ts:274, 398-414`, index `packages/db/src/registry.ts:129` | `mcpApprovals` per org and exact server key. |
| MCP collection | `apps/agent/src/collectors/codeburn.ts:216-218` | Server = second `__` part of an `mcp__` tool name. |
| Skill runs | `codeburn.ts:219-220` | A `Skill` tool call lands in `toolUsage.skill` as a count. The skill's name is dropped. |
| Skill names | `codeburn.ts:247`, `packages/shared/src/schemas.ts:93` | `skillCounts` from `attributionSkill`. Claude Code sets it on few lines. |
| Top quartile | `apps/api/src/routes/dashboard/quartile.ts` (A6, web-v0.17.0) | `quartileSplit`, null below `MIN_QUARTILE_PEOPLE` (4). |

## What the data says today

Prod, read-only, 2026-11-23. 2 Claude Code users, 0 teams, 0 approvals.

- 16 distinct MCP server keys: 10 local, 2 plugin, 3 claude.ai, 1 unnamed.
  None is used by both users.
- `toolUsage.skill`: 702 runs on 41 days. `skillCounts`: 0 docs with any
  key. So prod has skill runs and no skill names.
- On this Mac, every `Skill` tool call sampled from the Claude Code logs (9
  of 9) has an input with keys `skill` and `args`. The name is in `skill`.
  `args` is free text typed by the user.

So the MCP half has the data it needs. The skills half needs an agent
change: read `input.skill` from the `Skill` tool call, as the agent already
reads the server name from MCP tool names.

## Scope

In:
- `recommendedSetup(group, servers, skills, approvals)`: pure function.
- MCP recommendations per team and for the org, on `/adoption`.
- Skill recommendations, behind the agent change (Decision 4).
- A copyable checklist per team.

Out:
- Writing files into anyone's repo, or a ready `.mcp.json`. The server has
  names only, no commands or URLs.
- Approving servers from this page. B3 does that.
- Per-person suggestions ("you should install X").
- Non-Claude agents.

## Data

### Reference group

The people whose setup is worth copying: the team's members who are in
the org's top quartile (A6 `quartileSplit`, org-wide). The org split is
used because most teams are under A6's minimum of 8 (Decision 1). An org
list uses the whole top quartile.

No list when the org split is null (fewer than 8 Claude Code users) or the
team's reference group has fewer than 2 people. The page says which.

### Rule

An item (server or skill) is recommended for a group when it was used on
at least 1 day in range by at least half of the group and by at least 2
people. The 2-person floor means a one-person tool never shows, which also
keeps personal skill names off the page.

Per item the page shows: used by `a` of the top group, `b` of the whole
team.

### MCP by source

| Source | Recommended as |
|---|---|
| local | An entry for the repo's `.mcp.json`. Name only; the lead fills in the command. |
| plugin | Install the plugin. The key is `plugin_<plugin>_<server>`. |
| claude.ai | Connect it in claude.ai settings. Cannot live in `.claude/`. |
| unnamed | Skipped. A UUID tells the reader nothing. |

When the org has at least one approval, only approved servers are
recommended; unapproved ones used by top users show to admins as "Used by
top users, not approved" with a link to Governance > MCP (Decision 3).

### Skills (after the agent change)

Agent: in the tool loop at `codeburn.ts:219`, when `toolName === 'skill'`
and `block.input.skill` is a string, count it into a new map `skillRuns`.
Never read or send `args`. Drop names over 200 characters, the limit
`McpServerKeySchema` uses (`schemas.ts:210`); `countMap` (`schemas.ts:40`)
caps no key today.

Server: `skillRuns: countMap.optional()` in `ClaudeEnrichmentSchema`
(`schemas.ts:75`), `skillRuns: Record<string, number> | null` on
`ClaudeEnrichmentDoc` (`packages/db/src/documents.ts:274`), mapped in
`packages/db/src/usage.ts:147`. `skillCounts` stays for A5. No validator
on the collection, so no schema sync.

Skill names like `superpowers:brainstorming` come from a plugin; plain
names may be project or personal skills. The checklist says "plugin
skill" or "skill" and does not guess the folder.

Until enough devices run the agent with `skillRuns`, the skills list shows
"Skill names need agent 0.6 or later" and the count of top users who have
it.

### Reads

MCP: the A6 route already runs `mcpServersPipeline` for the same people
and range. Add one `mcpApprovals.find({ orgId })`, as `GET /governance/mcp`
does. Skills: one `$objectToArray` on `skillRuns`, grouped by user, in the
same enrichment read. No new index.

## API

Extend A6's `PracticesResponse` (Decision 2). Same route, roles, audit.

```ts
interface SetupItem {
  key: string
  kind: 'mcp-local' | 'mcp-plugin' | 'mcp-claude.ai' | 'skill' | 'plugin-skill'
  topUsers: number; teamUsers: number
  approved: boolean | null    // MCP only; null for skills
}
interface TeamSetup {
  teamId: string | null; teamName: string   // null teamId = org list
  groupSize: number
  items: SetupItem[]
  reason: 'ok' | 'noSplit' | 'smallGroup'
  skillsKnown: number         // top users with a skillRuns day in range
}
// PracticesResponse gains:
setup: TeamSetup[]
```

No names or user ids. Counts only, so "Hide my name" does not apply.

## Dashboard

A "Recommended setup" block in the A6 section on `/adoption`.

- One card per team, plus "Whole org" first. Each card: MCP items grouped
  by source, skill items, and a "Copy checklist" button that copies plain
  text such as:
  `MCP for .mcp.json: github, linear. Plugin: superpowers. Skills: (needs agent 0.6)`.
- Unapproved servers carry a badge for admins only.
- Empty states use `reason`: "Needs 4 or more Claude Code users in the
  org" or "Fewer than 2 top users in this team".

## Tests

- `recommendedSetup`: half of group passes, under half fails; 2-person
  floor with a group of 2 and of 3; unnamed skipped; source mapping; only
  approved when approvals exist, all when none; skill and plugin skill by
  `:`.
- Agent: `Skill` call with `input.skill` counts; missing or non-string
  `skill` ignored; `args` never in the payload; name over 200 dropped.
- Schema: payload with and without `skillRuns` passes; old docs read as
  null.
- Route: `noSplit` below 8; `smallGroup`; response has no user ids;
  approvals from another org ignored.
- Page: cards, checklist text, badges for admins only.

## Release

Two releases.

1. MCP half: next web minor after A6, `--latest=false`. No agent release,
   no schema sync.
2. Skills half: the agent change goes in agent 0.6.0 (Decision 4), with
   the server field in the same PR set; the skills list turns on in the
   web release after 0.6.0 ships. `/privacy` gains `enrichment.skillRuns`
   (`apps/dashboard/src/lib/transparency.ts`, audience `scoped`, comment
   "Adoption") and one line in the privacy page copy.

## Decisions (open)

1. **Reference group.** Team members in the org's top quartile, at least
   2. Recommended: it works for teams under 8 and still means "top users".
   Other choices: the team's own top quartile (empty for most teams), or
   A7's champions (1 or 2 people, too few to call anything "shared").
2. **Where it lives.** In A6's route and section. Recommended: same people
   and pipeline, one more find. Other choice: its own route, which repeats
   A6's work.
3. **Approvals.** Once an org approves any server, recommend approved ones
   only and flag the rest to admins. Recommended: a team setup should not
   push a server governance has not cleared. With no approvals (prod
   today) everything shows.
4. **Skill names and agent release.** Count `input.skill` from the `Skill`
   tool call into a new `skillRuns` map, never `args`, and ship it in agent
   0.6.0. Recommended: every device has to update for the 0.6.0 cutover
   anyway, and on 2026-11-22 only 1 of 7 devices ran 0.4, so a separate
   release would wait months for reach. The change is additive and
   optional. Other choice: its own agent minor after 0.6.0, which keeps the
   cutover diff smaller at the cost of a second update round.
5. **Personal skill names.** Show only skills used by 2 or more people.
   Recommended. R0.3 already allows skill names to leave the machine
   (`tasks/R0.3-AGENT-PRIVACY-DESIGN.md:142`); the floor keeps a one-off
   name, which might carry a client's name, off a manager's screen.

## Steps

1. `recommendedSetup` in `quartile.ts`; unit tests.
2. Shared types; extend `PracticesResponse`; route adds approvals and
   setup; route tests.
3. Page block, checklist copy, page test. Release the MCP half.
4. With 0.6.0: agent `skillRuns`, schema, doc type, `usage.ts` mapping,
   transparency and privacy copy; tests.
5. After 0.6.0 ships: turn on the skills list, next web minor.
6. Changelog and roadmap row per release.
