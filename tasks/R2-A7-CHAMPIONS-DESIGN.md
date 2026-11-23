# R2 · A7 Champions per team: design

Status: draft 2026-11-23, decisions open. Roadmap: `tasks/ROLLOUT-ROADMAP.md`
R2, row A7 ("Suggest 1 or 2 champions per team"). Builds on A5
(`tasks/R2-A5-FEATURE-MATRIX-DESIGN.md`) for who used what and A6
(`tasks/R2-A6-TOP-QUARTILE-DESIGN.md`) for the top quartile. Respects A8
(`tasks/R1-A8-LEADERBOARD-DESIGN.md`) privacy settings.

## Goal

For each team, suggest one or two people who use Claude Code often and use
several features, so a manager can ask them to help teammates. Each
suggestion says why ("18 of 30 days, uses MCP, skills, subagents") and what
they could help with (features most of the team does not use yet).

A suggestion is a hint shown on the page. Nothing is stored, nobody is
told, nothing changes for the person suggested.

## What exists today

| Piece | Where | Today |
|---|---|---|
| Per-person features | `apps/api/src/routes/dashboard/features.ts:34-54`, route `adoption.ts:374` onward | `FeaturePerson { userId, name, teamIds, activeDays, days }`. In progress on `feat/r2-a5-feature-matrix`. |
| Top quartile | A6 design, `quartile.ts` (not built) | `quartileSplit(people, tokens)`, null below 8 people. |
| Power user rule | `apps/api/src/routes/dashboard/adoption.ts:44-47` | `funnelThresholds`: power = active on `ceil(rangeDays * 5 / 7)` days. |
| Hide my name | `routes/dashboard/leaderboard.ts:331, 348`; A5 route `adoption.ts` (people build) | A8: hidden users show as "Anonymous" to all but admins and themselves. A5: managers see "Hidden". |
| Org name setting | `leaderboard.ts:157-160, 331` | `showNames` off shows "Person N" to managers and developers. |
| Teams and scope | `apps/api/src/plugins/jwt.ts:144` (`readScope`), `comparableTeams` | Admin org-wide, manager own teams. |

## What the data says today

Prod, read-only, 2026-11-23. 0 teams, 6 users, 2 with Claude Code data.
Range 2026-10-24 to 2026-11-22 (30 days), enrichment days per feature:

| | Claude days | MCP | Skills | Subagents | Plan |
|---|---|---|---|---|---|
| User 1 | 21 | 18 | 17 | 15 | 2 |
| User 2 | 14 | 13 | 2 | 2 | 0 |

User 1 uses all four and User 2 uses three, but neither reaches the power
user line of 22 days. No team row exists, and the "No team" group has 2
Claude Code users, below the minimum of 3 (Decision 2). Prod shows the
empty state until teams exist and fill up. The power rule is strict on
purpose; Decision 1 lists the looser choice.

## Scope

In:
- `suggestChampions(team, people, split)`: pure function, 0 to 2 people.
- A `champions` list added to the A6 practices response, per visible team.
- A "Suggested champions" block on `/adoption`, inside the A6 section.

Out:
- Storing, accepting or dismissing a champion. No new field.
- Notifying the person or the manager. Waits on the notification channel.
- Champions per feature (one person per feature). Possible later from the
  same function.
- Developers. They never see this.
- Non-Claude agents, as in A5.

## Data

No new query. A7 runs on the people, tokens and split that the A6 route
already builds.

A person is eligible in team T when all of these hold:

1. Member of T (`teamIds` includes T) with at least one Claude Code day.
2. Power user in range: `activeDays >= ceil(rangeDays * 5 / 7)`, the A3
   rule. A 30-day range needs 22 days.
3. Uses at least 3 of the 4 always-known features (`mcp`, `skills`,
   `subagents`, `plan`), each on at least 1 day. SDK is left out: it is
   unknown for most people (A5 Decision 4).
4. When the org split exists (A6, 8+ people org-wide), in the org's top
   quartile. When it does not, rules 2 and 3 alone decide.
5. Not hidden (Decision 3).

Rank eligible people by features used, then active days, then Claude
tokens, then `userId`. Take the first 2. The org split is used for rule 4,
not the team's own split, because most teams are under 8 people.

"Can help with": features the champion uses that fewer than half of T's
Claude Code users use. Empty list is fine.

A team needs at least 3 Claude Code users in range for any suggestion
(Decision 2). Below that the team shows "Too few users to suggest".

## API

Extend `PracticesResponse` from A6. Same route, same roles, same audit.

```ts
interface ChampionSuggestion {
  userId: string
  name: string
  activeDays: number
  features: FeatureKey[]      // features used in range
  canHelpWith: FeatureKey[]
}
interface TeamChampions {
  teamId: string | null       // null = No team, admins only
  teamName: string
  users: number               // Claude Code users in range
  champions: ChampionSuggestion[]   // 0..2
  reason: 'ok' | 'tooFew' | 'noneEligible'
}
// PracticesResponse gains:
champions: TeamChampions[]
```

With a team filter, only that team. Managers get only their teams; admins
also get the No team row when no filter is set, as the funnel does.

## Privacy

A7 names people, so it follows A8 and A5 and goes one step further.

- `users.hideOnLeaderboard` true: never suggested to managers. Admins see
  them as eligible with a "Hidden from leaderboard" note. Showing a
  manager "Hidden" as a champion would point at the person anyway.
- Org `showNames` off: managers see no champion names; the block says
  "Names are off for this org." Admins still see names, as on the
  leaderboard.
- A viewer can be their own team's champion; they see their own name.
- No email in the response. Name and `userId` only, as A5 returns.

## Dashboard

Inside the A6 "Top users vs rest" section, a "Suggested champions" table:
Team, Champion, Active days, Uses, Can help with.

- One line above it: "People who use Claude Code most days and use 3 or
  more features. A suggestion only; nobody is told."
- Rows with `tooFew` or `noneEligible` show the reason in muted text.
- Shown even when the A6 comparison is below its minimum, because rule 4
  drops out on its own.

## Tests

- `suggestChampions`: power threshold at 22 and 21 days on a 30-day range;
  3 of 4 features passes, 2 fails; SDK ignored; rule 4 applied only when a
  split exists; rank order and tie break; at most 2; `canHelpWith` at
  exactly half of the team (not included) and under half (included).
- Team of 2 gives `tooFew`; team of 3 with nobody eligible gives
  `noneEligible`.
- Privacy: hidden user never in a manager's list, present with note for
  admin; `showNames` off empties names for managers only; self shown.
- Route: developer 403; manager sees own teams; No team only for admin
  without filter.
- Page: table, reasons, names-off line.

## Release

Next web minor after A6, `--latest=false`. It can ship in the same release
as A6 if both are ready. No agent release, no schema sync.

## Decisions (open)

1. **Eligibility.** Power user (A3 rule) plus 3 of 4 features, plus org top
   quartile when it exists. Active days here are A5's Claude Code days,
   not all-agent days. Recommended. A looser line, half the range days
   (15 of 30), would make both prod users eligible today. Other choices: top A8 score per
   team (mixes in tokens and streaks, rewards volume), or top quartile only
   (unavailable below 8 people, so most orgs would get nothing).
2. **Minimum team size.** 3 Claude Code users in range. Recommended: in a
   team of 2, "champion" just means "the other person". With rule 2 and 3
   being absolute, 3 is enough; the quartile minimum of 8 is not needed.
3. **Hidden users.** Skip them in managers' lists; admins see them with a
   note. Recommended. Other choice: show "Hidden" as A5 does, which in a
   list of 1 or 2 names identifies the person.
4. **Where it lives.** A block in the A6 section and in A6's response.
   Recommended: same people, same split, no second query. Other choice: a
   route and section of its own.
5. **Stored state.** None. Recommended for now. Accept or dismiss buttons
   need a new collection and an audit event; add them if managers ask.

## Steps

1. `suggestChampions` in `quartile.ts` next to `quartileSplit`; unit tests.
2. Shared types `ChampionSuggestion`, `TeamChampions`; extend
   `PracticesResponse`.
3. Route: build `champions` per visible team, apply privacy rules; route
   tests.
4. Page block and test.
5. Typecheck and all suites. `/privacy`: no new field stored; add
   "Adoption" to the comment on `enrichment.toolUsage` and
   `enrichment.mcpUsage` in `apps/dashboard/src/lib/transparency.ts:73, 75`
   if A5 has not already.
6. Changelog, PR, merge, next web minor. Check prod `/adoption` shows the
   No team row with "Too few users to suggest".
