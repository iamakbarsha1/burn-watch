# BurnWatch Rollout Roadmap

**Created:** 2026-11-18
**Source:** [BurnWatch-Rollout-Proposal.md](./BurnWatch-Rollout-Proposal.md)
**Previous plan:** [ROADMAP.md](./ROADMAP.md) (BW-01 to BW-42, deploy and hardening)
**Goal:** take BurnWatch from "works for the people building it" to a tool the
whole org (50+ developers) can use under seat billing, with adoption and
governance views managers and admins will act on.

Items use the proposal's IDs (A1, B3, C1, ...). Each one gets a BW ticket in
[TICKETS.md](./TICKETS.md) when its phase starts, not before.

---

## Scope at a glance

### Build (approved)

| Group | Items |
|---|---|
| Seat billing reframe | Value relabel, actual cost, value multiple, idle-seat / limit-hit alerts |
| Pre-rollout blockers | Teams + manager scope, path privacy, "What BurnWatch knows about me" page, bulk CSV invite, close BW-42, finish BW-21 |
| A. Adoption | A1, A3, A5, A6, A7, A8 |
| B. Governance | B1, B2, B3, B5, B6, B7, B8 |
| C. Attribution | C1, C2, C4, C5 |
| D. Extras | D1, D5, D6 |

### Discuss with org first (not scheduled)

| Item | Why it needs a decision | What it blocks |
|---|---|---|
| **Vercel Pro** | Hobby is non-commercial only. Not a feature choice: this is a licence issue that must be settled **before** rollout past the build team. Needs budget sign-off. | Rollout itself |
| **SSO (Google or Microsoft)** | Which IdP? 50+ password accounts means reset requests. Small to build once the provider is chosen. | Nothing, but support load grows without it |
| **Notification channel (Slack / Teams + email)** | Which channel? Who owns the webhook? | D2, A4, any push alert from A1/B2/B3 |
| D2 Weekly digest bot | Needs the notification channel. Moved from build to discuss 2026-11-18 | — |
| A2 Plan right-sizing | Needs tier list and prices; limit-hit logging not confirmed | D3 |
| A4 Nudges | Needs notification channel | — |
| B4 Permission-mode audit | Sensitive: can read as surveillance. Policy intent must be agreed first | — |
| B9 Retention policy | Legal/HR call on retention period | — |
| C3 Seat-cost allocation | Finance has to want per-client cost split | — |
| D3 Seat simulator | Depends on A2 | — |
| D4 Anomaly flags | "Shared credentials" flag overlaps B6; agree on tone first | — |
| **Own usage collector** | Replace the third-party usage collector (npx + node at runtime) with a built-in parser for Claude/Qwen/Gemini/Codex/Copilot logs, so the agent is one self-contained binary we can ship to employees and the public. Decided by the user 2026-11-22. Design: `tasks/AGENT-OWN-COLLECTOR-DESIGN-PART1.md` and `PART2.md`, decisions locked 2026-11-23. ✅ Phase 0 built, web-v0.12.0 on branch `feat/own-collector-phase-0`: collector renamed to `ReferenceCollector`, price table pinned to LiteLLM `18fe30f` (213 models), `GET /v1/prices`, optional `unpriced` on usage events. No agent change, no schema sync. Next: phase 1 (shadow, agent 0.5.0), build order step 4 | Shipping the agent outside the build team |

### Facts needed from the org before R1

1. Plan tiers in use and per-seat monthly price for each (A1, seat reframe).
2. Team list and manager for each team (Teams + manager scope).
3. Approved agents/models list (B2) and approved MCP servers (B3).
4. Client list with Git org patterns (C1), and any client AI restrictions (B7).
5. Minimum supported Claude Code version (B5). Closed by B5: admins set it on `/devices`; until they do, Claude Code is not flagged.

---

## Dependency map

```
R0 Foundations
  Seat model + value relabel ──────────────┬──▶ A1 idle seats, D1 value multiple
  Teams + manager scope (C5 included) ─────┼──▶ A3, A5, A6, A7 (per-team views), B8
  Agent v0.4 (path privacy + 🟡 fields) ───┼──▶ C1 ──▶ C2, B7
                                           ├──▶ A5, B5, B6, C4
  Transparency page (after agent v0.4 fields are final)
  Bulk invite, BW-42, BW-21

R1 Quick wins (existing data)   B1, B3, B2, A1, A3, A8, B8
R2 Insights on new fields       A5, B5, B6, C4 ──▶ A6 ──▶ A7, D5 ; D6
R3 Clients                      C1 ──▶ C2, B7
R4 Extras                       D1
```

One design call shapes the whole plan: **path privacy and every 🟡 field ship
in one agent release (v0.4.0).** The proposal lists them separately, but both
are agent changes. Developers update once, and the transparency page describes
a field set that will not change again a week later.

---

## R0 · Foundations (pre-rollout)

Nothing in R1+ is worth showing to managers until the numbers mean the right
thing and managers can see their team.

### R0.1 Seat model + value relabel · M

Status: done, PR #14 (agent 0.3.0 adds limit-hit counts). Admins still need to enter
real seat prices (org fact #1).

- `seats` collection: user, agent, monthly price, start date.
- Admin **Seats** section, with non-destructive "assign to everyone".
- Leaderboard: `$` becomes **Value (API-equivalent)**; add **Actual cost** and
  **Value multiple** (`value ÷ actual cost`).
- Overview: **Value received** and **Actual cost** tiles
  (`12 seats × $30/mo + $X API`).
- Budget alerts get a `type`: `api-spend` (only unseated usage), `idle-seat`,
  `limit-hit`.
- Rename "spend" on Trends, Projects, Admin team table.
- Design: [R0.1-SEATS-DESIGN.md](R0.1-SEATS-DESIGN.md), rewritten 2026-11-21 from
  proposal section 7 (the original spec was never committed).
- **Needs:** org fact #1.

### R0.2 Teams + manager scope (includes C5) · M

Status: done, merged in PR #7. Design and plan in
[R0.2-TEAMS-DESIGN.md](R0.2-TEAMS-DESIGN.md).

- `teams` and `team_members` collections in `packages/db`.
- `viewerScope` (`apps/api/src/plugins/jwt.ts:105`) today returns one userId or
  `undefined`. Change it to return a user-id set: own id for developers, team
  members for managers, `undefined` for admins. Every dashboard route already
  calls it, so the pipelines change from `userId` equality to `$in`.
- Team filter on Overview and Trends; team-vs-team comparison for admins (C5).
- Route tests: manager cannot read another team; developer still sees only
  self (extend the existing viewer-scope tests in `routes.test.ts`).
- **Needs:** org fact #2.

### R0.3 Agent v0.4.0 · M

Status: done, PR #15, agent v0.4.0 released. Migrations 0003-0004 ran on prod
2026-11-22 (paths folded to repo and command names). Teammates still need
`burnwatch update`; older agents keep working and the server strips their paths.

Design: [R0.3-AGENT-PRIVACY-DESIGN.md](R0.3-AGENT-PRIVACY-DESIGN.md), reviewed 2026-11-21.


One release, two parts.

- **Path privacy:** send repo name + normalised Git remote, never the absolute
  path. Decide what happens to paths already stored (strip to basename in a
  migration is the cheap answer).
- **New fields from Claude transcripts:** `attributionSkill`, `isSidechain`,
  `permissionMode`, `entrypoint`, `version`, `accountUuid` (hashed on device),
  `gitBranch`. (Limit-hit counts moved into R0.1, agent 0.3.0.)
- Collect `permissionMode` even though B4 is not approved: it is cheap now and
  costly to add later. The transparency page must list it. Do not build a view
  on it until B4 is agreed.
- Older agents keep working; new fields are optional server-side.

### R0.4 "What BurnWatch knows about me" page · S

Status: done, PR #16, released as web-v0.2.0. Page at `/privacy` ("My data" in
the sidebar). Field list walks `RegisterDeviceSchema` and `UsagePayloadSchema`;
who-can-see lives in `apps/dashboard/src/lib/transparency.ts`, and its test
fails when a schema field has no description or no audience.

- Every field collected, who can see it (self / manager / admin), and a plain
  statement that prompts and code are never collected.
- Generate the field list from the shared Zod schema so it cannot drift from
  what the agent sends.
- Ship after R0.3's field list is final.

### R0.5 Onboarding cleanup · S

Status: built on `feat/r0.5-onboarding`, released as web-v0.3.0. CSV invite on
the Admin page (`POST /v1/auth/admin/invites/bulk`, team joined on accept).
BW-42 closed (already fixed). BW-21 shipped as unverified.

- Bulk invite from CSV on the Admin page (email, role, team).
- Close BW-42 (stale lockfile entry, XS).
- BW-21 Copilot: still blocked on a real Copilot Business org. If none is
  available, ship it as "unverified" and record that in TICKETS.md rather than
  holding the rollout.

**R0 done when:** a manager logs in and sees only their team, every `$` on screen
is labelled as value or actual cost, agent v0.4 sends no absolute paths, and a
developer can open the transparency page.

---

## R1 · Quick wins on existing data

All S or S–M. Mostly new pipelines over data already in Mongo.

| ID | Build | Note |
|---|---|---|
| B1 | Free-tier usage list (`isFreeTier`), per user and team | ✅ Built, web-v0.4.0 (`/governance`). Design: `tasks/R1-B1-FREE-TIER-DESIGN.md`. Gemini gap is BW-43 (R2) |
| B3 | MCP server inventory from `mcpUsage`, allowlist, flag unapproved | ✅ Built, web-v0.5.0 (`/governance`, `mcpApprovals`). Design: `tasks/R1-B3-MCP-INVENTORY-DESIGN.md`. Admins approve on the page, so org fact #3 is no longer a blocker |
| B2 | Approved agents/models policy, violation list, dashboard alert | ✅ Built, web-v0.6.0 (`/governance`, `agentPolicies`, nav count + Overview line). Design: `tasks/R1-B2-AGENT-POLICY-DESIGN.md`. Push alerts wait for a channel |
| A1 | Idle seats: no usage for 14+ days, per agent | ✅ Built, web-v0.7.0 (`/adoption`, `?idleDays` default 14, alert links to it). Design: `tasks/R1-A1-IDLE-SEATS-DESIGN.md`. No schema change. Prod shows the empty state until seats are entered (org fact #1) |
| A3 | Funnel per team: invited → registered → first sync → active → power user | ✅ Built, web-v0.8.0 (`/adoption` Funnel section, page date range, who-is-stuck list). Design: `tasks/R1-A3-ADOPTION-FUNNEL-DESIGN.md`. Active 2+ days, power 5 of 7 days (scaled to the range). No schema change. Prod shows the total and "No team" rows until teams exist |
| A8 | Leaderboard by active days, streaks, features tried; `$` hidden by default | ✅ Built, web-v0.9.0 (`/users` sortable by active days, score, streak, tokens, cost; cost behind `?cost=1`; Admin leaderboard settings; "Hide my name" on `/users`). Design: `tasks/R1-A8-LEADERBOARD-DESIGN.md`. Two optional doc fields, no schema sync. Features-tried improves after R2 |
| B8 | Admin audit log: device approvals, role changes, who viewed whose data | ✅ Built, web-v0.10.0 (`/audit` admin page, `auditEvents` collection, `audit()`/`auditView()` in `apps/api/src/audit.ts`, `/privacy` line). Design: `tasks/R1-B8-AUDIT-LOG-DESIGN.md`. Prod schema sync before deploy. Hand edits to `users.role` are not logged; an org-role endpoint is its own item |

**R1 done when:** admins have a Governance page (B1, B2, B3), an Adoption page
(A1, A3), and the leaderboard no longer ranks by dollars.

**R1 status:** ✅ Done. All seven items built (web-v0.4.0 to web-v0.10.0).

---

## R2 · Insights on agent v0.4 fields

Starts once a meaningful share of devices run v0.4. Use A3's funnel plus B5's
version view to track that.

| ID | Build | Depends on |
|---|---|---|
| B5 | Claude Code version per device, flag below the minimum | ✅ Built, web-v0.11.0 (`/devices` Claude Code and Agent columns, admin-set minimum, "Update agent" below 0.4.0, active-device summary). Design: `tasks/R2-B5-AGENT-VERSIONS-DESIGN.md`. One optional org field, no schema sync, no agent release. Admins set the minimum on the page, so org fact #5 is no longer a blocker. On 2026-11-22, 1 of 7 devices ran agent 0.4 (1 of 3 active) |
| A5 | Feature matrix per team: MCP, skills, subagents, plan mode, CLI vs SDK | ✅ Built, web-v0.14.0 (`/adoption` Features section, Per person list, `GET /v1/dashboard/adoption/features`, `featureFlags()` in `routes/dashboard/features.ts`). Design: `tasks/R2-A5-FEATURE-MATRIX-DESIGN.md`. Four of five signals come from `toolUsage` on every agent version; SDK needs 0.4. No schema sync, no agent release |
| B6 | Hashed `accountUuid` vs assigned seat: personal accounts, shared seats | Built 2026-11-23 as web-v0.15.0: `tasks/R2-B6-ACCOUNT-SEATS-DESIGN.md`, decisions locked as recommended. Admin marks the company Claude org from orgs seen; one optional org field; no agent release. Depends on R0.3, R0.1 |
| C4 | Ticket keys from `gitBranch` (`PROJ-123-...`), usage per ticket/epic | Built 2026-11-23 as web-v0.16.0: `tasks/R2-C4-TICKET-USAGE-DESIGN.md`. New `/tickets` page, admin key allowlist, case-insensitive; epics out of scope; no agent release |
| A6 | Top quartile vs rest: MCP setup, skills, cache hit rate; generated tips | Built as web-v0.17.0 (2026-11-23): "Top users vs rest" on `/adoption`, `GET /v1/dashboard/adoption/practices`. `quartileSplit` (min 4 people, rank by active days, Claude tokens or A8 score) is shared with A7 and D5; fixed-rule tips. Design: `tasks/R2-A6-TOP-QUARTILE-DESIGN.md` |
| A7 | Suggest 1–2 champions per team | Built as web-v0.18.0 (2026-11-23): "Suggested champions" inside A6's section and `GET /adoption/practices`. Top 2 per team by the A6 Rank by picker, teams of 3+, hidden people skipped for managers; nothing stored. Design: `tasks/R2-A7-CHAMPIONS-DESIGN.md` |
| D6 | Onboarding score: weekly active + 2 features within 14 days | Built as web-v0.19.0 (2026-11-23): "Onboarding" on `/adoption`, `GET /v1/dashboard/adoption/onboarding`. Onboarded = tokens on 2+ days in each of the first two weeks and 2+ Claude Code features in 14 days from first sync. Design: `tasks/R2-D6-ONBOARDING-SCORE-DESIGN.md` |
| D5 | Recommended shared `.claude/` MCP + skills set per team | MCP half built as web-v0.20.0 (2026-11-23): "Recommended setup" cards in A6's section on `/adoption`, from `GET /adoption/practices`. Skill names wait on agent 0.6.0 (`skillRuns`). Design: `tasks/R2-D5-SHARED-SETUP-DESIGN.md` |

---

## R3 · Clients

| ID | Build | Depends on |
|---|---|---|
| C1 | Client registry: Git remote patterns → client + project | R0.3 path privacy, org fact #4 |
| C2 | Monthly client report: devs, sessions, value, tools, compliance; CSV first, PDF later | C1, B2 |
| B7 | Per-client policy ("Client X: no AI", "Client Y: Claude only") | C1, B2 |

---

## R4 · Extras

| ID | Build | Depends on |
|---|---|---|
| D1 | AI Wrapped: monthly/yearly recap, shareable | R0.1 value multiple, A5, A8 streaks |

---

## Order of work and rough size

| Phase | Items | Size |
|---|---|---|
| R0 | Seat model, teams, agent v0.4, transparency, onboarding | ~2 M + 1 M + 2 S |
| R1 | B1, B3, B2, A1, A3, A8, B8 | 7 × S/S–M |
| R2 | B5, A5, B6, C4, A6, A7, D6, D5 | 3 S + 5 M |
| R3 | C1, C2, B7 | 3 × M |
| R4 | D1 | M |

Each phase gets its own design note and its own session, per the one task per
session rule. R0.1 and R0.2 can run in parallel; R0.3 can start alongside them.

---

## Risks

- **Licensing:** shipping to the org on Vercel Hobby breaks its terms. Pro has
  to be decided before R0 is announced, even though no code depends on it.
- **Agent adoption lag:** R2 and R3 are only as good as v0.4 coverage. Track it
  with B5 and nudge manually until a channel exists.
- **Trust:** B6, B8 and the manager scope can feel like monitoring. Ship the
  transparency page (R0.4) before managers get access, not after.
- **Rate limiter debt (BW-05):** still in-memory per instance. Bulk invite and
  wider rollout increase exposure; repay before opening registration to 50+.

---

## Next session

Shipped 2026-11-22/23: R1 B8 (web-v0.10.0), prod-check fixes (web-v0.10.1, agent
v0.4.1), R2 B5 (web-v0.11.0), enrichment dedupe (agent v0.4.2), own collector
phase 0 (web-v0.12.0), own collector phase 1 shadow (web-v0.13.0, agent v0.5.0).
Next: own collector build order step 8, parsers for Qwen, Gemini CLI, Codex and
Copilot CLI from `burnwatch compare --dump-shape <agent>` samples, then two weeks
of shadow data (`referenceDiff` on devices) before 0.6.0. Still open: confirm or
rule out the macOS `~/Desktop` block after an 18:00 sync (`burnwatch status`,
`projectBreakdown.remote`), `burnwatch compare` on Windows, re-send past days to
correct doubled enrichment, `/users` and `/devices` table width, seat prices
(org fact #1), Vercel Pro, `COPILOT_ENCRYPTION_KEY` on prod, R2 A5 design.

```
BurnWatch: check `burnwatch status` and projectBreakdown.remote after the 18:00 sync (macOS ~/Desktop block); confirm the new-collector line in status.
Then own collector step 8: collect --dump-shape samples for Qwen, Gemini CLI, Codex, Copilot CLI and write the first parser per tasks/AGENT-OWN-COLLECTOR-DESIGN-PART2.md.
```
