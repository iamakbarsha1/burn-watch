# BurnWatch v2: no micromanagement

Branch: `main-v2` (cut from `main` at `bbf5a9a`, 2026-11-24).
Status: Phase 0 built on `main-v2` (2026-11-24). Phases 1 to 5 not started.

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

### Phase 1: no ranking

- [ ] Delete leaderboard route, score, `SCORE_WEIGHTS`, per-person cost, value multiple, no-ticket per person.
- [ ] New `GET /v1/dashboard/me/usage`: the caller's own days, streak, cost, features, onboarding checklist, setup checks, seat status. Reuse `streaks.ts` and the onboarding and feature helpers, scoped to the caller.
- [ ] New "My usage" page (replaces the leaderboard part of `users/page.tsx`).
- [ ] Team usage distribution for managers (counts per band, k >= 5).
- [ ] Remove `LeaderboardSettingsForm.tsx`, the settings route and schema, `hideOnLeaderboard` route and form. Migration in `packages/db` unsets `leaderboard` on orgs and `hideOnLeaderboard` on users.
- [ ] Shared types: drop `LeaderboardEntry`, `LeaderboardSettings*`.

### Phase 2: adoption without names

- [ ] Funnel: drop `StuckPerson[]`, keep counts.
- [ ] Features: drop `FeaturePerson[]`, return per-feature team share.
- [ ] Onboarding: manager view returns cohort counts only; per-person progress moves to `/me/usage`.
- [ ] Champions: replace auto-pick with an opt-in flag on the user (`helpVolunteer: boolean`), set by the person only. Practices page lists volunteers.

### Phase 3: governance and alerts

- [ ] Budget alerts: remove per-user scope and `limit-hit` per person; add team-level "people hitting limits" count.
- [ ] Personal account and free-tier: admin gets counts; person gets a notice on "My usage".
- [ ] Rename violations to "Setup checks" in API names, UI and audit sentences. Person sees own checks.
- [ ] Idle seats to "Unused seats": trim the response to name, seat, days since last use. Person sees their own status.
- [ ] Devices: confirm no manager route exposes `lastSeenAt` for others.
- [ ] MCP inventory (`/governance/mcp`): drop the per-server user list for managers and admins; keep counts. Found by the Phase 0 check, missed by the audit.

### Phase 4: transparency and words

- [ ] `GET /v1/dashboard/audit/me` and an "Who viewed my data" section on "My usage".
- [ ] Update `transparency.ts` for every field added, removed or moved. Its test already blocks gaps.
- [ ] Add "What BurnWatch will never do" to /privacy: rank people, score people, show one person's usage to a manager, read prompts or code.
- [ ] Word sweep across API, UI, docs and audit sentences. CI check like the old-name guard: fail on `leaderboard|streak|stuck|missed|violation|score` in dashboard UI strings, with an allowlist for code that must keep a word (for example "self streak" on "My usage" if we keep that label).
- [ ] README, `docs/ARCHITECTURE.md`, `docs/INSTALL.md`, rollout proposal: describe BurnWatch as "team-level Claude Code cost and adoption, with a private view for each person".

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
