# BurnWatch v2: no micromanagement

Branch: `main-v2` (cut from `main` at `bbf5a9a`, 2026-11-24).
Status: Phases 0 and 1 merged into `main-v2` (PRs #42, #43). Phase 2 built on `v2/p2-adoption-no-names` (2026-11-24). Phases 3 to 5 not started.

## Why

The 2026-11-24 audit found that BurnWatch collects little (counts only, no prompts or code) but shows too much about named people. Managers can rank people, see streaks, and read lists of who is "stuck", who "missed" onboarding, who hit a limit and who costs what. That reads as surveillance, and it would hurt every team that installs it.

v2 keeps what helps an org run Claude Code well (cost, adoption, seat use, security setup) and drops what grades individuals.

## The rules v2 follows

1. **Groups for managers, self for people.** Admins and managers see team and org totals. Each person sees their own numbers in full. Nobody sees another person's usage numbers.
2. **Minimum group size of 5.** Any team or filter with fewer than 5 people returns "group too small" instead of numbers. One shared check, not one per route.
3. **No ranking, scoring or streaks.** No list sorted by how much someone uses AI. No 0 to 100 score. No daily-presence tracking shown to anyone but the person.
4. **Named lists only for admin operations, and only with symmetry.** A named list is allowed only where an admin must act on one person (reclaim an unused seat, fix a security setting). The person sees the same fact about themselves, and the /privacy page lists it.
5. **People can see who looked.** Every person can see the audit log of views that covered them.
6. **Plain, neutral words.** No "score", "streak", "stuck", "missed", "violations", "leaderboard".

A real-MongoDB check enforces rules 1, 2 and 4 (see Phase 0).

## Feature decisions

| Feature today | v2 | Why |
|---|---|---|
| Leaderboard, 0 to 100 score (`leaderboard.ts`, `SCORE_WEIGHTS`) | **Remove.** Replace with a private "My usage" page for each person. Managers get a team distribution (how many people use it 0, 1 to 2, 3 to 4, 5 days a week), no names. | Ranking people is the core problem. |
| Streaks and active days per person (`streaks.ts`) | **Self only.** Shown on "My usage". Never in a manager or admin response. | Presence tracking. |
| Cost per person, value multiple, API spend per person | **Remove per person.** Keep cost by org, team, project, ticket. Each person sees their own cost. | Puts a price on a person. |
| No-ticket cost per person | **Remove per person.** Keep "share of spend tied to a ticket" per team. | Reads as "unaccounted work". |
| Funnel "stuck" list (`/adoption/funnel`) | **Remove names.** Keep stage counts per team (k >= 5). | Names people who use AI less. |
| Onboarding "missed" / "in progress" (`/adoption/onboarding`) | **Self only.** New hires see a private "getting started" checklist. Managers see cohort counts (k >= 5). | Pass/fail grading of new hires. |
| Feature matrix per person (`/adoption/features`) | **Remove names.** Keep "% of team that has used feature X" (k >= 5). | Per-person grid. |
| Champions (`/adoption/practices`) | **Opt-in.** People volunteer as "happy to help with Claude Code" in their own settings. No auto-picked names. | Singles people out without consent. |
| Limit-hit alerts per user (budget alert `limit-hit`) | **Aggregate.** "N people hit usage limits this week" per team, as a signal to raise limits. Person sees their own limit hits. | Alerting on a named person. |
| Per-user budget alerts | **Remove.** Keep org and team budgets. | Personal spend cap reads as monitoring. |
| Personal-account detection (`/governance/accounts`) | **Self notice + count.** The person sees a notice on "My usage". Admins see a count. | Security goal met without a named list. |
| Free-tier use (`/governance/free-tier`) | Same as personal accounts. | Same. |
| Policy violations (`/governance/violations`) | **Keep, renamed "Setup checks".** Admin sees names (security control). Person sees the same check on their own page. | Real security need; symmetry rule. |
| Idle seats (`/adoption/idle-seats`, idle-seat alerts) | **Keep, renamed "Unused seats".** Admin only, shows only "no use in 30 days", no other stats. Person sees "your seat is marked unused". | Real licence cost. |
| Devices, hostname, last seen (`/devices`) | **Keep for admins** (asset management). Remove "last seen" from any manager view. Person sees their own devices. | IT need. |
| Leaderboard settings (`developerView`, `showNames`, `showOthersCost`) and `hideOnLeaderboard` | **Delete.** Settings with nothing left to control. Migration unsets the fields. | Dead once the leaderboard goes. |
| Overview, trends, team compare, activity, projects, tickets, top-quartile (A6), recommended setup (D5), seats admin, version badge | **Keep.** Add the k >= 5 check where a team filter applies. | Already aggregate. |
| Audit log (`/audit`, admin only) | **Add self view.** `/audit/me`: views that covered teams I belong to. Admin view stays. | People can see who looked. |

The agent does not change. It already sends counts only. No agent release.

## Phases

Each phase is one PR into `main-v2`, with a Vercel preview. Tests and typecheck pass before each merge.

### Phase 0: guardrails first (done 2026-11-24)

- [x] `MIN_GROUP_SIZE = 5` in `packages/shared`. `readScope` returns `too_small` for a scope with other people but fewer than 5; routes answer 403 `{ error: 'group_too_small', minGroupSize: 5 }` through `refuse`. Activity, projects and tickets moved from `viewerScope` to `readScope`. `MIN_QUARTILE_PEOPLE` is now derived: 17, so the top quarter is itself 5. Team compare leaves out teams under 5.
- [x] Dashboard: `GroupTooSmall` notice in `components/ui.tsx`, `unlessTooSmall` / `nullUnlessTooSmall` in `lib/group-too-small.ts`, used by overview, trends, activity, projects, tickets, adoption and governance.
- [x] `apps/api/src/scripts/no-individuals.ts` (`npm run no-individuals -w @burn-watch/api`): real MongoDB, data through POST /v1/usage, every dashboard GET as admin, manager of 6, manager of 2 and developer. Fails on another person's id, name or email outside the admin allowlist, and on any small-group read that is not refused. CI runs it on a single-node replica set. First run on today's code: 140 failures. Now passing, with 19 `KNOWN_LEAKS` entries for Phases 1 to 3 (ratchet: a listed route that stops leaking also fails).
- [x] Rules in `docs/ARCHITECTURE.md`. /privacy states only the group minimum, since the other rules are not true until later phases.
- [x] CI runs on PRs and pushes to `main-v2`.

Known gaps after Phase 0:
- An admin's whole-org view is not counted against the minimum. An org under 5 people still shows totals to its admin.
- Budget alerts still use `viewerScope` and are not checked for group size (Phase 3 reworks them).
- Some route tests pass a 1-person admin team filter only because the admin is the one member (the self exemption).

### Phase 1: no ranking (built 2026-11-24)

- [x] Deleted `leaderboard.ts`: the leaderboard route, score, `SCORE_WEIGHTS`, per-person cost, value multiple, API spend per person. Practices (A6) ranks by days or tokens only. `mcpServersPipeline` moved to `features.ts`.
- [x] New `GET /v1/dashboard/me/usage`: the caller's own active days, all-time streak, tokens, sessions, cost, per-agent split, agents and MCP servers used. Every read is filtered to the caller's id. Not audited.
- [x] New "My usage" page at `/me`, replacing `/users`.
- [x] New `GET /v1/dashboard/usage-distribution`: admin and manager, counts per band (none, 1 to 2, 3 to 4, 5+ days a week). Refused under 5 active people, admins included. Card on the Adoption page.
- [x] Removed `LeaderboardSettingsForm.tsx`, the settings routes and schema, the `hideOnLeaderboard` route and form. Migration `0005_drop_leaderboard_settings` unsets `leaderboard` on orgs and `hideOnLeaderboard` on users. Old audit rows (`org.leaderboard_settings`, `view.leaderboard`) still read.
- [x] Shared types: dropped `LeaderboardEntry`, `LeaderboardSort`, `LeaderboardSettings*`.
- [x] `KNOWN_LEAKS`: the two P1 entries removed. The check covers `/me/usage` (200 for every role) and `/usage-distribution` (k rule).

Moved to later phases: onboarding checklist on "My usage" (Phase 2), setup checks and seat status on "My usage" (Phase 3).

Known gaps after Phase 1:
- Champions (A7) no longer skip people who had hidden their name, because the hide flag is gone. Fixed in Phase 2.
- The no-individuals check finds names, ids and emails. It does not find another person's numbers without a name. Route tests cover `/me/usage` for that.

### Phase 2: adoption without names (built 2026-11-24)

- [x] Funnel: `stuck` list and `StuckPerson` removed. Stage counts stay.
- [x] Features: per-person grid (`FeaturePerson[]`) removed. Counts per group; the page shows each feature as a share of the group.
- [x] Onboarding: per-person list removed. `total` is null when fewer than 5 people first synced in range. The person's own first 14 days are on My usage (`onboarding` in `/me/usage`).
- [x] Funnel, features and onboarding: team rows only for teams of 5+ members (onboarding: cohorts of 5+). "No team" null under 5.
- [x] Champions: auto-pick removed. `helpVolunteer` on the user, set only by the person through `PUT /v1/dashboard/me/help-volunteer` (not audited). Practices lists volunteers per team. The D5 reference group is the top quartile plus volunteers.
- [x] `KNOWN_LEAKS`: the eight P2 entries removed. 9 left, all Phase 3.

Known gaps after Phase 2:
- D5 setup cards still give per-team counts for teams under 5 (counts of people using an MCP server, no names). Fold into Phase 3.
- The no-individuals seed has no volunteer, so a volunteer name on Practices is not exercised there. Route tests cover it.

### Phase 3: governance and alerts (built 2026-11-26)

- [x] Budget alerts: no per-person alerts. `userId` is gone from the input schema; migration `0006_drop_per_person_alerts` deletes the old ones. `GET /budget-alerts` is admin only and gives counts: unused seats for an idle-seat alert, people who hit a usage limit this month for a limit-hit alert. No names.
- [x] Free tier: counts per agent and model (`people`, `days`, `tokens`), no names. Claude accounts: `people` list replaced by `flagCounts`. The person sees their own free-tier use and account flags on My usage.
- [x] Violations renamed to setup checks: `/governance/setup-checks` and `/governance/setup-checks/count`. Admins get named rows (decision 2). Managers get the rules and a count of people. The person sees their own setup checks on My usage.
- [x] Idle seats renamed to unused seats: `/adoption/unused-seats`, admin only. Rows are name, seat, days since last use. The person sees their own seats on My usage.
- [x] Devices: `lastSeenAt` only comes from `/v1/auth/admin/*` routes, all behind `requireAdmin`. No manager route has it.
- [x] MCP inventory: per-server user list replaced by a `people` count.
- [x] D5 setup cards: no team card for a team under 5.
- [x] `KNOWN_LEAKS` is empty. The no-individuals check passes with 0 known leaks.

Known gaps after Phase 3:
- An admin of an org with fewer than 5 people still sees org totals (unchanged from Phase 0).
- My usage reads other people's account days to set the "shared" flag. Only days that share the caller's account hash are read, and only the caller's flags come back.

### Phase 4: transparency and words (built 2026-11-26)

- [x] `GET /v1/dashboard/audit/me`, every role: views whose scope covered the caller (whole org, a team they are in, or a manager's managed teams when they are in one). "Who viewed my data" on My usage. Not audited. Allowed to name viewers in the no-individuals check (rule 5).
- [x] `transparency.ts` checked: Phase 3 already updated it and its gap test passes. Views of you are not a field, so /privacy points to Who viewed my data instead.
- [x] "What BurnWatch will never do" on /privacy: rank people, score people, show one person's usage to a manager, read prompts or code.
- [x] Word sweep: onboarding state `missed` renamed `windowEnded`; code comments say setup check. `scripts/check-words.sh` runs in CI as "Neutral words" and fails on `leaderboard|streak|stuck|missed|violation|score` in non-test dashboard source. Allowlist: the private streak on My usage, historical audit labels.
- [x] `docs/ARCHITECTURE.md`, `docs/INSTALL.md`: describe BurnWatch as team-level Claude Code cost and adoption, with a private view for each person. The repo has no README. The rollout proposal has a v2 note at the top; its body is the original text.

Known gaps after Phase 4:
- "Who viewed my data" uses current team membership. Someone who left a team does not see views of it from before; someone who joined sees views of it from before they joined.
- The word check covers the dashboard only. API field names such as `streak` on `/me/usage` stay.

### Phase 5: ship

- [ ] Full suite, typecheck, dashboard pipelines on local Mongo.
- [ ] Preview check signed in as admin, manager and member: each page shows only what the rules allow.
- [ ] Merge `main-v2` into `main` by PR. Release `web-v1.0.0` (breaking: features removed). Prod deploy, then the same three-role check on prod.
- [ ] CHANGELOG entry that lists every removed feature and why.

## Decisions (confirmed 2026-11-24)

1. Minimum group size: **5**.
2. Unused seats and setup checks stay **named for admins**, with the symmetry rule.
3. Streaks: **kept, private** to the person on "My usage".
4. Releases: **one `web-v1.0.0`** when `main-v2` merges into `main`. No releases per phase.

## Risks

- Removing features breaks any admin who relies on the leaderboard today. The CHANGELOG and /privacy page say what went and why.
- Existing org docs hold `leaderboard` settings. The migration must run before the new code reads orgs, or the reader must ignore the field.
- The negative test needs realistic fixtures (6+ people, teams of 2 and 6) or it passes for the wrong reason.

## Protection

`main` and `main-v2` are under ruleset `protect-main-branches` (id 27950546): no deletion, no force push. Repository admins can bypass.
