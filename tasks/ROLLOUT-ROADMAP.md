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

### Facts needed from the org before R1

1. Plan tiers in use and per-seat monthly price for each (A1, seat reframe).
2. Team list and manager for each team (Teams + manager scope).
3. Approved agents/models list (B2) and approved MCP servers (B3).
4. Client list with Git org patterns (C1), and any client AI restrictions (B7).
5. Minimum supported Claude Code version (B5).

---

## Dependency map

```
R0 Foundations
  Seat model + value relabel ──────────────┬──▶ A1 idle seats, D1 value multiple
  Teams + manager scope (C5 included) ─────┼──▶ A3, A5, A6, A7 (per-team views), B8
  Agent v0.3 (path privacy + 🟡 fields) ───┼──▶ C1 ──▶ C2, B7
                                           ├──▶ A5, B5, B6, C4
  Transparency page (after agent v0.3 fields are final)
  Bulk invite, BW-42, BW-21

R1 Quick wins (existing data)   B1, B3, B2, A1, A3, A8, B8
R2 Insights on new fields       A5, B5, B6, C4 ──▶ A6 ──▶ A7, D5 ; D6
R3 Clients                      C1 ──▶ C2, B7
R4 Extras                       D1
```

One design call shapes the whole plan: **path privacy and every 🟡 field ship
in one agent release (v0.3.0).** The proposal lists them separately, but both
are agent changes. Developers update once, and the transparency page describes
a field set that will not change again a week later.

---

## R0 · Foundations (pre-rollout)

Nothing in R1+ is worth showing to managers until the numbers mean the right
thing and managers can see their team.

### R0.1 Seat model + value relabel · M

- `seats` collection: user, agent, monthly price, start date.
- Admin **Seats** section, with non-destructive "assign to everyone".
- Leaderboard: `$` becomes **Value (API-equivalent)**; add **Actual cost** and
  **Value multiple** (`value ÷ seat price`).
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

### R0.3 Agent v0.3.0 · M

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

- Every field collected, who can see it (self / manager / admin), and a plain
  statement that prompts and code are never collected.
- Generate the field list from the shared Zod schema so it cannot drift from
  what the agent sends.
- Ship after R0.3's field list is final.

### R0.5 Onboarding cleanup · S

- Bulk invite from CSV on the Admin page (email, role, team).
- Close BW-42 (stale lockfile entry, XS).
- BW-21 Copilot: still blocked on a real Copilot Business org. If none is
  available, ship it as "unverified" and record that in TICKETS.md rather than
  holding the rollout.

**R0 done when:** a manager logs in and sees only their team, every `$` on screen
is labelled as value or actual cost, agent v0.3 sends no absolute paths, and a
developer can open the transparency page.

---

## R1 · Quick wins on existing data

All S or S–M. Mostly new pipelines over data already in Mongo.

| ID | Build | Note |
|---|---|---|
| B1 | Free-tier usage list (`isFreeTier`), per user and team | Pure read |
| B3 | MCP server inventory from `mcpUsage`, allowlist, flag unapproved | Needs org fact #3 |
| B2 | Approved agents/models policy, violation list, dashboard alert | Push alerts wait for a channel |
| A1 | Idle seats: no usage for 14+ days, per agent | Uses R0.1 seats |
| A3 | Funnel per team: invited → registered → first sync → weekly active → power user | Uses R0.2 teams |
| A8 | Leaderboard by active days, streaks, features tried; `$` hidden by default | Features-tried improves after R2 |
| B8 | Admin audit log: device approvals, role changes, who viewed whose data | Moved up from "later": once managers see team data, view logging should exist from day one |

**R1 done when:** admins have a Governance page (B1, B2, B3), an Adoption page
(A1, A3), and the leaderboard no longer ranks by dollars.

---

## R2 · Insights on agent v0.3 fields

Starts once a meaningful share of devices run v0.3. Use A3's funnel plus B5's
version view to track that.

| ID | Build | Depends on |
|---|---|---|
| B5 | Claude Code version per device, flag below the minimum | R0.3, org fact #5 |
| A5 | Feature matrix per team: MCP, skills, subagents, plan mode, CLI vs SDK | R0.3, R0.2 |
| B6 | Hashed `accountUuid` vs assigned seat: personal accounts, shared seats | R0.3, R0.1 |
| C4 | Ticket keys from `gitBranch` (`PROJ-123-...`), usage per ticket/epic | R0.3 |
| A6 | Top quartile vs rest: MCP setup, skills, cache hit rate; generated tips | A5 |
| A7 | Suggest 1–2 champions per team | A5, A6 |
| D6 | Onboarding score: weekly active + 2 features within 14 days | A3, A5 |
| D5 | Recommended shared `.claude/` MCP + skills set per team | A6 |

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
| R0 | Seat model, teams, agent v0.3, transparency, onboarding | ~2 M + 1 M + 2 S |
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
- **Agent adoption lag:** R2 and R3 are only as good as v0.3 coverage. Track it
  with B5 and nudge manually until a channel exists.
- **Trust:** B6, B8 and the manager scope can feel like monitoring. Ship the
  transparency page (R0.4) before managers get access, not after.
- **Rate limiter debt (BW-05):** still in-memory per instance. Bulk invite and
  wider rollout increase exposure; repay before opening registration to 50+.

---

## Next session

Design R0.2 (Teams + manager scope) or R0.1 (Seat model). R0.2 is the larger
risk because it changes the scope rule every dashboard route depends on.

```
BurnWatch rollout R0.2: design teams + manager scope.
Admins see all, managers see their team, developers see self.
Change viewerScope in apps/api/src/plugins/jwt.ts to return a user-id set,
add teams/team_members to packages/db, add team filter + team comparison
to Overview and Trends (C5). Extend viewer-scope route tests.
See tasks/ROLLOUT-ROADMAP.md.
```
