# BurnWatch Roadmap

**Created:** 2026-11-04
**Goal:** get BurnWatch deployed on Vercel, tested, and feature-complete.
**Ticket board:** [TICKETS.md](./TICKETS.md)

---

## Decisions locked 2026-11-04

| Question | Decision |
|---|---|
| Agent scope | All agents stay in schema, config, and collectors. Claude ships first because that is what the company runs. Qwen/Gemini/Codex/Copilot features stay on the roadmap, just later. |
| Hosting | One Vercel project using Vercel Services. Render is removed. |
| Why not Render | Free tier spins down after inactivity, so the first request pays a 30-60s wake-up. |
| Why Services over two projects | Dashboard and API share one origin. That removes CORS config and cross-site cookie handling for `bw-api-token` and the better-auth session. One preview URL, one rollback. |
| Test stack | Vitest. Unit tests plus Fastify route tests through `app.inject()` with db and redis mocked. No database in CI. |

**Cost note:** Vercel Hobby is non-commercial-use only. A tool tracking 50+ developers at a company needs a Pro seat.

**Amended 2026-11-05:** shipping on Hobby for now, user's decision, under the
personal account `iamakbarsha1` (project `akbar-sha-ss-projects/burn-watch`).
The licensing point above stands and is not resolved by this — revisit before
the tool is rolled out past the people building it. Services and service
bindings were confirmed working on Hobby, so nothing in the architecture above
depends on the upgrade.

**Constraint found 2026-11-05:** Vercel Services rejects Edge Runtime output.
Next.js middleware is Edge by default, so the dashboard cannot use middleware
without opting into the experimental Node middleware runtime. The auth-redirect
middleware was moved into layouts instead. Anything added later that reaches for
middleware has to account for this.

---

## Sequencing

The order is driven by what blocks what, not by how visible each item is.

```
P0 Unblock          BW-01 ──▶ BW-02
                              │
P1 Ship on Vercel             ├──▶ BW-03 ──┬──▶ BW-04 ──▶ BW-07 ──▶ BW-08
                              │            │    BW-05 ──┘
                              │            │    BW-06 ──┘
                              │            │
P2 Safety net                 │            └──▶ BW-09 ──▶ BW-10
                              │                 BW-09 ──▶ BW-11, BW-12, BW-13
                              │                 BW-10..13 ──▶ BW-14
                              │
P3 Integrity                  └──────────────▶ BW-15, BW-16, BW-17

P4 Features                                     BW-18, BW-19, BW-20, BW-21
P5 Polish                                       BW-22, BW-23, BW-24
```

### Three dependencies worth knowing before you start

**BW-01 comes first because it is a CI gate and a test prerequisite.**
The API has 19 TypeScript errors from one root cause: `apps/api/src/plugins/jwt.ts`
redeclares Fastify's own `jwt` and `user` properties instead of augmenting
`@fastify/jwt`'s `FastifyJWT` interface. That makes `request.user` type as
`string | object | Buffer`, so every route reading `request.user.orgId` fails.
Route tests assert on exactly those fields, so they cannot be written against a
broken type. Fix the one file and 17 downstream errors go with it.

**BW-03 is one refactor with two consumers.**
`server.ts` currently builds the app and calls `server.listen()` at module top
level. Vercel Functions cannot use a listening server, and `app.inject()` route
tests need an app instance without a bound port. Splitting into `buildServer()`
plus a thin `listen` entry point serves the deployment and the test suite from
the same change. Do it once, before either.

**BW-05 ships with the Vercel move, not after it.**
`@fastify/rate-limit` is registered with no store, so it counts in process
memory. On Render there was one instance and that was fine. On Vercel Functions
every concurrent instance keeps its own counter, so a `max: 3 per hour` guard
becomes `3 × instances`. The admin bootstrap and device registration limits stop
working the moment traffic spreads. Upstash Redis is already connected, so this
is a store option and a plugin-ordering change, but it has to land in the same
release as the move.

---

## Phases

### P0 — Unblock CI

Nothing else can be trusted while typecheck is red. Two tickets, one afternoon.

**Done when:** `npx turbo run typecheck` passes across all four workspaces.

### P1 — Ship on Vercel, delete Render

Takes the project from "pushed four months ago, never confirmed green" to a
verified live deployment on a host without cold-start penalties.

Includes two serverless corrections that are invisible on a single-instance host
but real on Vercel: the rate-limit store (BW-05) and client reuse across warm
invocations (BW-06).

**Done when:** `render.yaml` is deleted, both services answer on one Vercel
domain, and a login plus one dashboard query is confirmed working against the
deployed URL.

### P2 — Test safety net

Zero tests exist today. The security fixes from the June audit — auth guards,
org-scoping, token hashing — have no regression protection at all. Any of them
can be undone by an unrelated refactor without anyone noticing.

Route tests go first because they cover the highest-consequence behaviour: that
a user from org A cannot read org B's spend.

**Done when:** `turbo run test` is green and runs on every pull request.

### P3 — Data integrity and ops

Three leftovers from the June audit that are real but were never urgent enough
to block a deploy.

The one that matters most is BW-15. A usage submit performs three separate
database operations with no transaction around them. A failure partway through
leaves a user's events written but their daily snapshot stale, and nothing
retries it.

**Note:** BW-15 constrains BW-06. Neon's HTTP driver is the usual serverless
choice, but it cannot hold a transaction across statements. Staying on the
WebSocket `Pool` driver is what makes BW-15 possible, so BW-06 hoists the
existing Pool for reuse rather than swapping the driver.

**Done when:** usage submit is atomic, `/health` reports real dependency state,
and schema changes go through generated migration files instead of
`drizzle-kit push`.

### P4 — Features

Everything here has schema already in place and no code behind it. These are the
four tables and one env var that exist but are unused.

Claude depth first, per the scope decision. Each ticket is written so that
multi-agent support is kept, not removed.

### P5 — Polish

Documentation drift and styling. Real work, lowest consequence if deferred.

BW-24 matters more than it looks: `REVIEW.md` sits in the repo root reading like
a current defect list, but roughly 20 of its 28 findings were fixed months ago.
Anyone new to the project will read it as the present state and be wrong.

---

## What is explicitly not in this roadmap

- Removing any agent from the schema. All five stay.
- API versioning beyond the existing `/v1` prefix.
- Table partitioning or other 1000x scale work from the June audit's scalability
  section. Revisit past a few hundred developers.
- Microfrontends or splitting the dashboard.

---

## Progress

Update [TICKETS.md](./TICKETS.md) as tickets move. This file only changes when
the plan itself changes.
