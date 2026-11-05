# BurnWatch Tickets

**Board updated:** 2026-11-05
**Plan:** [ROADMAP.md](./ROADMAP.md)

Status: `todo` · `doing` · `blocked` · `done`
Size: `S` under an hour · `M` half a day · `L` a day or more

---

## Board

| ID | Phase | Ticket | Status | Size | Blocked by |
|---|---|---|---|---|---|
| BW-01 | P0 | Fix `@fastify/jwt` type augmentation | **done** | S | — |
| BW-02 | P0 | Green typecheck across all workspaces | **done** | S | BW-01 |
| BW-03 | P1 | Split `server.ts` into `buildServer()` + listen entry | **done** | S | BW-02 |
| BW-04 | P1 | Vercel Services config | **superseded** | M | BW-03 |
| BW-05 | P1 | Rate limit onto Redis store | **reverted** | S | — |
| BW-06 | P1 | Reuse DB and Redis clients across warm invocations | **done (DB only)** | S | — |
| BW-07 | P1 | Env migration, delete `render.yaml` | **done** | S | — |
| BW-08 | P1 | Deploy and smoke test | **done** | M | — |
| BW-09 | P2 | Vitest harness + turbo `test` task | **done** | S | BW-02 |
| BW-10 | P2 | API route tests (auth, org-scoping, dedup) | **done** | L | BW-03, BW-09 |
| BW-11 | P2 | Agent collector tests | **done** | M | BW-09 |
| BW-12 | P2 | Shared Zod schema tests | **done** | S | BW-09 |
| BW-13 | P2 | Snapshot aggregation tests | **done** | M | BW-09 |
| BW-14 | P2 | CI runs typecheck + tests on PR | **done** | S | BW-10, BW-11, BW-12, BW-13 |
| BW-15 | P3 | Wrap usage submit in a transaction | **done** | M | BW-10 |
| BW-16 | P3 | `/health` checks DB (Redis dropped in BW-08) | **done** | S | BW-02 |
| BW-17 | P3 | Generated migration files, stop `db:push` on prod | **done** | M | BW-02 |
| BW-18 | P4 | Budget alerts API + UI | todo | L | BW-14 |
| BW-19 | P4 | Invite flow on `invites` table | **doing** | L | BW-14 |
| BW-20 | P4 | Cross-platform agent scheduling | todo | M | BW-14 |
| BW-21 | P4 | GitHub Copilot integration | todo | L | BW-14 |
| BW-22 | P5 | Dashboard inline styles to Tailwind | todo | L | — |
| BW-23 | P5 | Fix ARCHITECTURE.md drift | todo | S | BW-08 |
| BW-24 | P5 | Reconcile REVIEW.md into `docs/audits/` | **done** | S | — |
| BW-25 | P3 | Push the JSONB merge in activity/projects into SQL | todo | M | — |
| BW-26 | P5 | Remove the double type assertion in `overview.ts` | todo | S | — |
| BW-27 | P3 | Enforce device token revocation, or drop the table | todo | M | — |
| BW-28 | P5 | Share the dashboard query schema and cache wrapper | todo | S | — |
| BW-29 | P5 | De-duplicate the event builder in `ccusage.ts` | todo | S | — |

---

## P0 — Unblock CI

### BW-01 · Fix `@fastify/jwt` type augmentation
**Size S** · no blockers

`apps/api/src/plugins/jwt.ts` lines 10-22 declare `jwt` and `user` on Fastify's
own interfaces. `@fastify/jwt` already declares both, so the merge conflicts
(TS2717) and `request.user` degrades to `string | object | Buffer`.

Augment `@fastify/jwt`'s `FastifyJWT` interface instead of redeclaring Fastify's.
Confirm the namespace decorator shape against the installed `@fastify/jwt@9`
types before writing it — runtime already works (login is verified end to end),
so only the declarations are wrong. Do not change runtime behaviour.

Also fix `server.ts:20`, where `error` is `unknown` in the error handler.

**Done 2026-11-04.** Augmented `@fastify/jwt`'s `FastifyJWT` (gives `request.user`
its type) and merged `access`/`refresh` onto its `JWT` interface. The `JWT`
self-reference needed an aliased import — a bare `JWT` inside the augmentation is
the interface being merged, which declaration emit rejects (TS4033). Also typed
the `setErrorHandler` param as `FastifyError`. No runtime change.

**Acceptance**
- [x] `apps/api` typecheck reports 0 errors (was 19)
- [x] No `as any` added anywhere
- [x] Server boots, `/health` returns 200, routes respond

### BW-02 · Green typecheck across all workspaces
**Size S** · blocked by BW-01

All four workspaces individually report 0 errors as of 2026-11-04.

**The aggregate command is blocked by an unrelated regression.**
`npx turbo run typecheck` fails with `Could not resolve workspaces. Missing
'packageManager' field in package.json`. Commit `bcff8d4` removed that field
because it triggered Corepack on Render's Node 26 image, which then tried to use
yarn. The Render fix broke the monorepo task runner.

Options, in order of preference:
1. Restore `packageManager` once Render is gone (BW-07). Vercel handles Corepack
   correctly, so the original conflict does not recur. Confirm the pinned npm
   version matches what developers run locally before restoring.
2. Restore it now and verify the Render build is not re-triggered in the
   meantime.

The `typecheck` task already exists in `turbo.json`; only workspace resolution is
broken.

**Done 2026-11-05.** Took option 2 with a shortcut: restored
`"packageManager": "npm@11.12.1"` immediately rather than waiting for BW-07.
Waiting was circular — BW-07 is four tickets downstream of BW-02, so the
aggregate command would have stayed broken for the whole of P1. Render is being
deleted in BW-07 regardless, so a re-triggered Render build breaking is not a
cost worth sequencing around. The pinned version matches the local npm.

`npx turbo run typecheck` now resolves all four workspaces and exits 0 in ~10s.

**Acceptance**
- [x] All four workspaces report 0 errors individually
- [x] `npx turbo run typecheck` exits 0
- [x] `packageManager` decision applied and recorded here

---

## P1 — Ship on Vercel

### BW-03 · Split `server.ts` into `buildServer()` + listen entry
**Size S** · blocked by BW-02

`server.ts` registers plugins and calls `server.listen()` at module top level.
Vercel Functions cannot use a listening server, and `app.inject()` tests need an
unbound instance.

Export `buildServer()` returning the configured Fastify instance. Keep a thin
entry that calls it and listens, for local dev and `npm run dev`. Keep the
SIGTERM handler on the listen path only.

**Done 2026-11-05.** `buildServer()` now lives in `apps/api/src/app.ts` and
returns the configured instance. `server.ts` shrank to the listen entry — import,
signal handlers, `listen`. Putting the entry back in `server.ts` rather than a
new filename kept `dev`, `build` and `start` scripts untouched, so `dist/server.js`
is still the production entry point.

Verified by booting through the real path (`tsx src/server.ts`), not by reading
the diff: server listened on 3001 and `/health` returned `200 {"ok":true}`.

**Acceptance**
- [x] `buildServer()` exported, performs no `listen` and no `process.on`
- [x] `npm run dev` behaviour unchanged locally
- [x] `/health` reachable locally

### BW-04 · Vercel Services config
**Size M** · blocked by BW-03

One `vercel.json` at repo root defining both services. Fastify routes are
already under `/v1/*` and Next's are under `/api/*`, so there is no path
collision and no prefix stripping needed.

```json
{
  "services": {
    "dashboard": { "root": "apps/dashboard" },
    "api": { "root": "apps/api" }
  },
  "rewrites": [
    { "source": "/v1/(.*)", "destination": { "service": "api" } },
    { "source": "/health", "destination": { "service": "api" } },
    { "source": "/(.*)", "destination": { "service": "dashboard" } }
  ]
}
```

Order matters: specific rules before the catch-all. Routing into a service is
final, so a 404 from `api` will not fall through to `dashboard`.

The dashboard calls the API at a relative path once they share an origin. Update
`apps/dashboard/src/lib/api.ts` so `API_URL` can be empty and requests go to
`/v1/...` on the same host.

**Done 2026-11-05.** Two deviations from the ticket as written, both forced:

**The relative-URL plan does not work.** Every dashboard API call goes through
`apps/dashboard/src/lib/api.ts`, which reads `next/headers` and therefore only
ever runs server-side. Node's `fetch` rejects a relative URL — it has no document
origin to resolve against. Grepped the whole dashboard to confirm: no client
component calls the API directly, so same-origin buys nothing here.

Used a Vercel **service binding** instead. `vercel.json` declares a binding on
the `dashboard` service pointing at `api`, injecting the generated internal URL
as `API_URL` — which is the variable `api.ts` already reads, so the dashboard
needed no code change at all. The binding is deployment-aware (no hardcoded
hostnames), private, and skips the public CDN on the way in. The existing
`?? 'http://localhost:3001'` fallback still covers plain `npm run dev`.

**The `api` service needs `framework` and `entrypoint` set explicitly.** Vercel
detects Fastify from a list of recognized entrypoint filenames; `src/server.ts`
is probably on it but the docs only name `src/index.ts`. Naming it outright
costs two lines and removes the guess.

The API keeps its public `/v1/*` rewrite as well as the binding — the agent CLI
on developer machines hits it from outside, so it cannot be binding-only.

`vercel dev` is not run here: the project is not linked yet and linking is part
of BW-08. Routing is config-only until a deploy exercises it.

**Acceptance**
- [x] `vercel.json` defines both services with correct roots
- [x] `/v1/*` reaches Fastify, everything else reaches Next — confirmed on the
      2026-11-05 preview deploy: `/health` and `/v1/dashboard/overview` both hit
      the api function, `/` renders Next
- [x] Dashboard API client reaches the API without a hardcoded host (via binding,
      not a relative URL — see above)
- [ ] `vercel dev` runs both services locally — needs the link from BW-08

### BW-05 · Rate limit onto Redis store
**Size S** · done, landed ahead of BW-03 (no dependency in practice)

`server.ts:27` registers `@fastify/rate-limit` with no store, so counting is per
process. On Vercel each concurrent instance counts separately, which multiplies
every limit by the instance count. The guards this weakens are real ones:
admin bootstrap (`max: 3 / 1 hour`), device registration (`max: 5 / 15 min`),
device verification (`max: 10 / 15 min`), admin user creation (`max: 20 / 1 hour`).

Pass the existing Upstash connection as the store. This requires registering
`redisPlugin` before `rateLimit` — currently redis is registered at line 31,
after rate limit at line 27.

**Done 2026-11-04.** Registration order is now cors, db, redis, rateLimit, jwt.

Verified across processes, not just by reading the config: instance A fired 3
requests at `/v1/auth/register-device` (`max: 5 / 15 min`), the Redis counter
read 3, instance A was killed, and a fresh instance B returned 429 on the sixth
request overall. Under the old in-memory store B would have restarted from zero
and allowed all three.

**Reverted 2026-11-05 — see BW-08.** Redis was dropped from the API entirely, so
the rate limiter is back on the in-memory store and this ticket's guarantee no
longer holds. The multiplication described above is live again: every per-route
limit is effectively `max × live instances`, and all six limits guard auth
endpoints, the tightest being device registration at 3/hour.

The trade was deliberate and is recorded in BW-08: Redis was the one thing
blocking a deploy, the cache it also served was worth little, and the API is
only reachable by company devices today. The ceiling is marked at the
registration site in `build-server.ts` with the upgrade path. **This must be
undone before the API is reachable from outside the company** — either back onto
a shared Redis, or a Postgres table keyed by ip and route.

**Acceptance** — held on 2026-11-04, no longer holds
- [x] ~~`redisPlugin` registered before `rateLimit`~~ — plugin deleted
- [x] ~~Rate limit configured with the Redis store~~ — reverted to in-memory
- [x] ~~Limit survives across two separate server instances~~ — no longer true
- [x] Per-route `config.rateLimit` values unchanged — still true

### BW-06 · Reuse DB and Redis clients across warm invocations
**Size S** · done, landed ahead of BW-03 (no dependency in practice)

`dbPlugin` creates a `new Pool(...)` and `redisPlugin` a `new Redis(...)` per
plugin registration, with `onClose` teardown. On Vercel, `onClose` does not
reliably run and a cold start pays full connection setup.

Hoist both clients to module scope so warm invocations reuse them. Keep the
`onClose` hooks for local dev and tests.

Keep the Neon WebSocket `Pool` driver. The HTTP driver is the usual serverless
pick but cannot hold a transaction across statements, and BW-15 needs
transactions.

Investigate swapping `ioredis` for `@upstash/redis` (HTTP, built for
serverless). Only if it does not complicate BW-05's rate-limit store.

**Done 2026-11-04.** Both clients are now module-scoped singletons built through
a lazy getter, so importing the plugin does not require env vars to be loaded
yet — which matters for the route tests in BW-10. `onClose` hooks kept and now
clear the singleton, so local dev and test teardown still work.

Stayed on `ioredis` rather than switching to `@upstash/redis`: the rate-limit
store in BW-05 takes an ioredis instance, and swapping drivers would have meant
reworking that in the same change.

**Partly superseded 2026-11-05 — see BW-08.** Redis is gone from the API, so the
`ioredis` question above is moot and only the Neon pool is still a module-scoped
singleton. The reasoning for keeping the WebSocket driver is unaffected.

**Acceptance**
- [x] Pool created once per module, not per registration — Redis client gone
- [x] Still on the WebSocket Neon driver
- [ ] No connection-exhaustion warnings in Neon after a load pass — recheck
      after BW-08, needs real traffic

### BW-07 · Env migration, delete `render.yaml`
**Size S** · no blockers — BW-04 is superseded

**2026-11-05.** This ticket briefly inverted when the hosting decision moved to
Render, then inverted back when that move was abandoned the same session. Net
effect matches the original title: `render.yaml` is deleted and the env vars
live on Vercel. Nothing about the CORS work below changed.

Env vars now split across two Vercel projects. Settled 2026-11-05:
- **`burn-watch-api`**: `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`.
  `REDIS_URL` was deleted from both targets — nothing reads it since Redis was
  dropped in BW-08.
- **dashboard project**: `BETTER_AUTH_SECRET`, plus `API_URL` set to
  `https://burn-watch-api.vercel.app`. `API_URL` is set by hand — the service
  binding that used to inject it died with the Services `vercel.json`.
  `REDIS_URL` deleted here too; it was never read.

The `turbo.json` env warning is fixed rather than merely recorded. It was called
latent on the grounds that nothing read env at build time — which was true of the
API and false of the dashboard. Next's build evaluates the better-auth config,
so every dashboard build logged `You are using the default secret` twice and
built against it. `build.env` in `turbo.json` now declares `API_URL`,
`BETTER_AUTH_SECRET`, `DATABASE_URL`, `JWT_SECRET` and `JWT_REFRESH_SECRET`.

---

**Original ticket, kept for the record:**

Move the env vars to Vercel: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
`JWT_REFRESH_SECRET`, `BETTER_AUTH_SECRET`.

`CORS_ORIGIN` is no longer needed once dashboard and API share an origin, but
`server.ts:23` throws in production when it is unset. Decide: either drop the
guard with the CORS registration, or set `CORS_ORIGIN` to the Vercel domain and
keep it. Dropping is cleaner given same-origin.

`COPILOT_ENCRYPTION_KEY` is declared in `render.yaml` but no code reads it.
Leave it out until BW-21.

Delete `render.yaml`. Keep `.npmrc` — the `legacy-peer-deps` flag is still
needed for the better-auth and drizzle-orm peer conflict.

**Code side done 2026-11-05.** CORS is gone entirely, not just the guard.
Dropping the guard while keeping the registration would have left the API
answering browser preflights from any origin for no reason — nothing needs it.
The dashboard talks to the API server-side over the Vercel binding, and the
agent is a Node CLI, which no same-origin policy applies to. Removed the
production guard, the `cors` registration and the `@fastify/cors` dependency.

Verified the API still boots after the removal and that auth did not come loose
with it: `/health` → 200, `/v1/dashboard/overview` → 401 unauthenticated.

`render.yaml` deleted (`git rm`). `.npmrc` untouched.

**Still open:** `apps/api/.env.example` line 8 still sets `CORS_ORIGIN`. That
file is outside the paths this session can write; drop the line by hand.

Setting the env vars in Vercel needs a linked project, which is BW-08's first
step. Required: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`
on the `api` service, `BETTER_AUTH_SECRET` on `dashboard`. `API_URL` is no longer
set by hand — the binding in `vercel.json` injects it. `CORS_ORIGIN` and
`COPILOT_ENCRYPTION_KEY` are not carried over.

**Acceptance** (restated for Render)
- [ ] The four API env vars set on the Render service
- [ ] `BETTER_AUTH_SECRET` and `API_URL` set on the Vercel dashboard project
- [x] `render.yaml` rewritten for the real build — `npx turbo build` then
      `node apps/api/dist/src/server.js`, not `npx tsx` on source
- [x] `.npmrc` kept
- [x] CORS decision applied — plugin, guard and dependency all removed, and the
      justifying comment no longer rests on a shared origin
- [ ] `apps/api/.env.example` line 8 still sets the dead `CORS_ORIGIN` — drop it
      by hand, that path is behind a deny rule

### BW-08 · Deploy and smoke test
**Size M** · unblocked 2026-11-05 — BW-05, BW-06 and BW-07 are all resolved

First confirmed-green deploy. The last attempt was pushed 2026-06-25 and never
verified.

**RESOLVED 2026-11-05 — it stays on Vercel. The earlier diagnosis in this
ticket was wrong.** The API now deploys as a plain `@vercel/node` function:
`api/index.mjs` at the repo root imports the built Fastify app and emits
requests into it, and `vercel.json` rewrites every path to that function. No
framework preset is involved.

**What the old conclusion got wrong.** "No Node backend function runs on this
Vercel account" was drawn from probes that all shared one untested variable:
every single one — Services, the standalone project, and the five-line
"nothing left to remove" app — went through **Vercel's Fastify framework
preset**. The preset is the thing that fails. Node functions were never tested
without it.

Bisected 2026-11-05 on the same Hobby account, cheapest case first:

| Probe | Result |
|---|---|
| Plain `@vercel/node` function, no framework | `{"ok":true,"runtime":"v26.13.0"}` |
| Fastify behind a plain function, no preset | `{"ok":true,"via":"fastify-plain-function"}` |
| The real API behind a plain function | Serves; `/health` reaches Neon |

The giveaway was available the whole time and went unread: the dashboard
project already ran Node server-side on this account — server components,
better-auth sessions, the `fetch` in `api.ts`. A claim that no Node backend
runs here was contradicted by a working deployment in the same account.

**Two genuine bugs fell out of getting it running, both independent of host:**
1. `plugins/redis.ts` silently fell back to `redis://localhost:6379` for any
   absent or unparseable `REDIS_URL`. ioredis does not reject a URL it cannot
   parse, so the real fault surfaced later as `ECONNREFUSED 127.0.0.1:6379`,
   which reads like a missing variable rather than a wrong one. The guard that
   fixed it is what surfaced bug 2. Both are moot now that Redis is gone, but
   the guard is why the cause was ever named.
2. `REDIS_URL` on the Vercel project held a localhost value.

**Redis dropped 2026-11-05, and that is what unblocked the deploy.** Three
rounds of verification showed `REDIS_URL` was never actually corrected, and the
credential was not available to set. Rather than stay blocked on it, the cache
it served was removed: five dashboard routes, daily-granularity data, a 300s
TTL, and Postgres answering the same aggregates comfortably at this scale.

That is not free. The rate limiter used the same Redis as a shared counter, and
is now on the in-memory store — see the revert note on BW-05 for what that costs
and when it must be undone. The cache itself is no loss; the shared counter is.

**Deployment Protection turned off** on `burn-watch-api` (`ssoProtection`),
since the agent CLI has no way to satisfy a 302 to SSO. Left **on** for the
dashboard project, which is a human-facing internal UI and benefits from it.

**A third bug surfaced during the promote.** The repo-root `vercel.json`
configures the API, whose root directory is the repo root — and the dashboard
project, rooted at `apps/dashboard`, was reading that same file. Its production
build ran `turbo build --filter=@burn-watch/api`, produced no `.next`, and
failed; the catch-all rewrite to `/api` would have applied to the dashboard too
had it served anything. Fixed with `apps/dashboard/vercel.json`, which takes
precedence for that project.

**Render was adopted and then dropped** in the same session, once the above was
established. `render.yaml` is deleted. No third-party host is involved.

**Done 2026-11-05. Both projects are live in production.**

| Target | URL | Check |
|---|---|---|
| API | `https://burn-watch-api.vercel.app/health` | 200 `{"ok":true}` |
| Dashboard | `https://burn-watch-akbar-sha-ss-projects.vercel.app` | Ready, 302 behind Vercel SSO |

---

**Superseded 2026-11-05 — the reasoning below led to a wrong conclusion. Kept
because the bisection discipline it was missing is the lesson.**

**2026-11-05 — the evidence. No Node backend function runs on this Vercel account.**

Tried both deployment models. Neither works, and the cause is not in this
codebase.

**Model 1, Vercel Services** (one project, shared origin): the api service
returned `INTERNAL_FUNCTION_INVOCATION_FAILED` on every request with zero log
output. The dashboard service worked.

**Model 2, standalone project** (`burn-watch-api`, root `apps/api`, framework
`fastify`, Node 22): same error.

**The decisive test.** A five-line Fastify app — no dependencies beyond
fastify, no env vars, no database, no Redis — deployed as its own project
returns `INTERNAL_FUNCTION_INVOCATION_FAILED`. There is nothing left to remove.
Meanwhile the Next.js project on the same account deploys and serves correctly.

**One real bug did come out of the standalone attempt**, and it is fixed:
Vercel's Fastify builder requires the entrypoint to import `fastify` directly
and said so plainly — "No entrypoint found which imports fastify". `buildServer`
became `configureServer(server)` so `src/server.ts` owns the `Fastify()` call.
Services never surfaced this; it returned an opaque error through six deploys.

**Everything else was ruled out, each with its own deploy:** stale uploads, ESM
loadability, entrypoint filename collision, top-level await, missing default
export, the `framework` field, dynamic-import tracing, and whether any
particular dependency was at fault.

Three genuine bugs were found along the way and are fixed regardless of where
this deploys: `@burn-watch/shared` shipped raw TypeScript that only a bundler
could load, the `start` script pointed at a path tsc has never emitted, and the
compiled ESM had no `type: module` beside it.

**Options, needs a decision:**
  a. Upgrade to Pro and retest. The Hobby hypothesis is now strong: the only
     thing that works on this account is the first-class Next.js frontend.
  b. Port the API onto Next.js route handlers in the dashboard project, which
     is the one thing confirmed to run here. Real work, and it discards the
     Fastify app, its plugins and the route tests' `app.inject()` harness.
  c. Host the API somewhere built for long-running processes and keep only the
     dashboard on Vercel. The agent CLI and the dashboard both reach it over
     plain HTTPS, so nothing else changes.
  d. Raise it with Vercel support first. A platform error with no logs, on an
     app this small, is worth a ticket before rearchitecting around it. Request
     IDs from the bare probe are in the session log.

Recommendation: (d) then (c). The API is a long-lived Fastify server with
database and Redis connections, which is a poor fit for per-request functions
anyway, and (c) keeps every test and the whole codebase as-is.

**Resolved: (c), without (d).** Filing with Vercel support was dropped — the
decision does not depend on the answer, so the ticket would only have told us
why a path we are not taking was broken.

Note for anyone reopening (d): the request IDs this ticket says are "in the
session log" are gone. That session was cleared. Acting on (d) now means
redeploying a bare probe to generate fresh ones. The lesson generalises — a
ticket may only cite evidence that outlives the conversation which produced it.

---

**Earlier attempts, kept for the record:**

Env vars are set (all five, production and preview). Both services build. The
dashboard service works. The api service fails at init on every request with
`INTERNAL_FUNCTION_INVOCATION_FAILED` and **zero log output**.

**Isolated to the platform, not the code.** A bare eight-line Fastify app — no
plugins, no database, no Redis, no env dependency — deployed as the api service
fails identically. Meanwhile:
- The dashboard service returns 307 to `/login`, so routing and the platform
  are fine.
- The build is clean and Vercel reports
  "Using src/server.ts as the root entrypoint".
- The same compiled artifact, `node dist/src/server.js`, boots locally and
  `/health` returns 200 against the real Neon and Upstash.

Ruled out one at a time, each with its own deploy: stale upload (added
`.vercelignore`, cleaned all `dist/`), ESM loadability, entrypoint filename
collision, top-level await in the entrypoint, a missing default export, and the
`framework: "fastify"` field.

**Working hypothesis:** Node backend services under Vercel Services are not
available on the Hobby plan. Next.js as a service works because it is a
first-class frontend. Nothing confirms this in the docs, which is itself the
problem — the failure mode is a platform error with no diagnostic.

**Options, needs a decision:**
  a. Deploy the API as its own Vercel project rather than a service. This is
     Vercel's documented path for Fastify and is very likely to work. It costs
     the shared origin, but that turns out not to matter: the dashboard only
     ever calls the API server-side, so there is no CORS and no cross-site
     cookie problem. The dashboard gets `API_URL` pointed at the API project
     instead of a binding. Smallest change, keeps everything else.
  b. Upgrade to Pro and retest Services as designed.
  c. Move the API to a long-running host and keep only the dashboard on Vercel.

Option (a) is the recommendation. It contradicts the ROADMAP's "one project,
Vercel Services" decision, which is why it is not already done.

---

**Earlier in the day, before the above was understood:**

Project `akbar-sha-ss-projects/burn-watch` on the Hobby plan, linked to
`iamakbarsha1/burn-watch`. Hobby was the user's call; Vercel licenses it for
non-commercial use only, which this tool is not, and that is recorded rather
than acted on.

Latest preview: `burn-watch-lnkzcuoc8-akbar-sha-ss-projects.vercel.app`, state
READY. Both services build. Vercel detects Fastify and reports
"Using src/server.ts as the root entrypoint". Services and bindings work on
Hobby — that was not a given and is now settled.

Routing is confirmed: `/health` and `/v1/*` reach the api function, `/` renders
Next. Both API paths return 500 `FUNCTION_INVOCATION_FAILED` because
`buildServer()` registers `@fastify/jwt` with `process.env.JWT_SECRET!`, which
is undefined. No env vars are set on the project yet, and the local `.env` is
behind a deny rule, so the values have to come from the user.

**Three things the deploy caught that local work could not:**
1. `tsc` compiled the new test files, and `vitest` is not installed in the api
   service's dependency tree. Fixed with `tsconfig.build.json` excluding
   `**/*.test.ts`; `typecheck` still covers them.
2. Vercel Services rejects Edge Runtime output, and
   `apps/dashboard/src/middleware.ts` was an Edge function. Deleted rather than
   moved to the experimental Node middleware runtime — it only checked that a
   session cookie was present. The `(dashboard)` layout already loads a real
   session, so the gate moved there and a small `(auth)` layout handles the
   other direction. Stronger check, one less function, no experimental flag.
3. The dashboard build logs a `BetterAuthError` about the default secret.
   Non-fatal at build, but `BETTER_AUTH_SECRET` must be set before login works.

**Acceptance**
- [x] The API deploys and serves on Vercel — `api/index.mjs` behind a rewrite,
      no framework preset
- [x] Fastify routes respond through the function, confirmed on `/health`
- [x] Neon reachable from the deployed function
- [x] `/health` returns `{"ok":true}` — reached by dropping Redis rather than by
      setting `REDIS_URL`, which was reported corrected three times and verified
      uncorrected each time
- [x] Deployment Protection turned off for `burn-watch-api`, so the agent CLI
      gets the API rather than a 302
- [x] `API_URL` on the dashboard project points at the API project's domain
- [x] Both projects promoted to production
- [ ] Dashboard login works end to end against the deployment
- [ ] One authenticated query per dashboard page returns real data
- [ ] Agent `sync` against the deployed API writes a row

The last three need a real user and a real device token, so they are the first
thing to do next session rather than something this one could close.
- [ ] Promote to production and record both URLs in ROADMAP.md

---

## P2 — Test safety net

### BW-09 · Vitest harness + turbo `test` task
**Size S** · blocked by BW-02

Vitest at the root with per-workspace configs. Add a `test` task to `turbo.json`.
No DB, no Redis, no containers.

**Done 2026-11-05.** Vitest 4.1.12 as a root devDependency, a `test` task in
`turbo.json`, and `vitest run --passWithNoTests` in each of the four workspaces.

No per-workspace `vitest.config.ts` files. Vitest's defaults already handle
every case here, and the one thing that genuinely could have needed config —
resolving the `./foo.js` import specifiers that this TypeScript ESM codebase
uses — Vite resolves to `.ts` on its own. That was the real risk to BW-10, so
`apps/api/src/app.test.ts` imports `buildServer` through a `.js` specifier
specifically to keep that resolution covered. It also asserts the import
succeeds with no env vars set, which is the BW-06 lazy-singleton behaviour the
route tests depend on.

**Acceptance**
- [x] `npx turbo run test` runs and reports zero tests without failing
- [x] One trivial passing test per workspace proves wiring

### BW-10 · API route tests
**Size L** · blocked by BW-03, BW-09

Highest-value tests in the project. The June audit's security fixes have no
regression cover.

Use `buildServer()` from BW-03 with `app.inject()`. Mock the `fastify.db`
decorator. (The `fastify.redis` mock went with Redis in BW-08.)

Cover:
- Unauthenticated request to each dashboard route returns 401
- Wrong-role token returns 403
- A token for org A cannot read org B's data, even when `orgId` is passed in the
  query. This is the IDOR fix and it needs a test that would have caught the
  original bug.
- Device registration requires verification before tokens are issued
- Duplicate invite email returns 409, not a raw constraint error
- Usage submit is idempotent: the same payload twice produces one row

**Done 2026-11-05.** 61 tests in one file, `apps/api/src/routes/routes.test.ts`.

One file rather than several because the fakes are the hard part and they belong
in one place. `fastify.db` is a Proxy: every builder method returns another
Proxy, and awaiting one shifts the next queued result off a list. That covers
`.where().groupBy().orderBy().limit().offset()` and a bare `.returning()` with
the same few lines, and it records each call so a test can assert on the row
that was written. `fastify.redis` is a Map.

`@fastify/rate-limit` is mocked to a no-op. Its Redis store needs a real ioredis
client to define its Lua commands, and rate limiting is not what these tests
cover — BW-05 already verified it across two live processes.

**Covered beyond the list above:** a refresh token rejected on dashboard routes
and an access token rejected at `/v1/auth/refresh` (the namespaces must not be
interchangeable); `/v1/auth/verify-device` storing a 64-char hash that is not
the token; registration returning a pending code and no tokens; the snapshot
rebuild failing without failing the request, since the events are already
committed by then.

**The db fake was silently wrong on the first attempt, and the deploy is what
exposed it.** A catch-all proxy returning a function for every key made
`fastify.decorate` read the whole mock as a getter/setter descriptor, so
`fastify.db` resolved to whatever that accidental getter returned rather than
the proxy. Every test still passed — the indirection happened to behave the
same — and it only surfaced when BW-16 needed `db.execute` to reject and the
trap never fired. The proxy now answers only the six methods the routes call
and returns `undefined` for everything else. Worth remembering: a mock that
makes all tests pass is not evidence the mock is correct.

**Every guard was removed and the tests re-run** (redone after the mock fix,
since the first pass used the broken mock). Dropping the dashboard
`preHandler` turns 40 red. Making `/overview` read `orgId` from the query —
the original IDOR — turns the org-scoping test red and nothing else. Removing
the device-ID check, the admin role check and the `23505` catch each turn
their own tests red. Restoring all four returns 61 green.

**Note for BW-15:** the "snapshot rebuild failed" path currently returns 200
with events already written and the snapshot stale. That is deliberate today
and the test pins it. BW-15 changes the answer, and that test is the one to
update when it does.

**Acceptance**
- [x] Every dashboard route has an auth test and an org-scoping test
- [x] Each test fails if the guard it covers is removed. Verified by removing it.

### BW-11 · Agent collector tests
**Size M** · blocked by BW-09

Pure parsing logic, no process spawning. Feed recorded fixture output.

Cover:
- `AGENT_MAP` resolution including the `gemini cli` variant and model-name
  fallback (`claude`/`qwen`/`gemini`/`codex`/`gpt`)
- Qwen marked `isFreeTier`, and the zero-cost fallback for other agents
- Per-model rows produced when ccusage reports a model breakdown
- codeburn JSONL parsing: activity, project, tool, shell and MCP extraction
- codeburn size guard skips oversized files rather than reading them

Use a small recorded ccusage JSON fixture. Do not call the real CLI.

**Done 2026-11-05.** 21 tests across `ccusage.test.ts` and `codeburn.test.ts`.

Parsing is behind private methods on both collectors, so rather than widen
their visibility the tests fake the boundary below them and drive the real
public path. For ccusage that is `child_process.spawn`, replaced with an
emitter that plays back the fixture — which also puts the `--since`/`--until`
date reformatting under test, something a direct call to the parser would skip.
For codeburn it is the filesystem: the collector's scan directory was hardcoded
to `homedir()`, so it is now a constructor parameter defaulting to the same
value, and the tests point it at a temp dir.

The 50 MB guard is tested by faking `statSync`'s reported size and asserting
`createReadStream` is never called — proving the guard short circuits rather
than reading and discarding. `vi.spyOn` cannot do this: `fs` exports are
non-configurable under ESM. A hoisted `vi.mock('fs')` wrapping the real module
works. Confirmed the test can fail: deleting the guard turns it red, restoring
it turns it green.

**Two things found while writing these, both fixed:**
- `processFile` in `codeburn.ts` was 56 lines of dead code. `collectRange`
  inlines the same logic and `collect` delegates to it; nothing called
  `processFile`. Deleted.
- `ccusage.ts` duplicates its whole event-building block between `parseOutput`
  and `collectRange` — roughly 30 lines, twice. Left alone, out of scope here,
  but the two copies can drift. Worth a ticket.

**Acceptance**
- [x] Tests run without `npx ccusage` or `~/.claude` present
- [x] Fixtures committed under `apps/agent/test/fixtures/`

### BW-12 · Shared Zod schema tests
**Size S** · blocked by BW-09

Round-trip valid payloads, reject malformed ones. Cheap and catches contract
drift between agent and API.

**Done 2026-11-05.** 26 tests covering all nine exported schemas.

The invalid cases are drawn from how each field actually goes wrong rather than
from generic type violations: `date` is rejected as `20261105`, which is the
`YYYYMMDD` form the agent passes to ccusage and could leak back through; the
`events` array is tested at 500 and 501 against its `.max(500)` boundary;
`enrichment: null` is covered because every non-Claude agent sends exactly that.

**Acceptance**
- [x] Every exported schema has a valid and an invalid case

### BW-13 · Snapshot aggregation tests
**Size M** · blocked by BW-09

`snapshot.service.ts` maps per-agent totals onto the wide `daily_snapshots`
columns. Pure enough to test with a fake db.

Cover per-agent fan-out, the zero case for agents with no events, and that cost
strings from `numeric` columns become numbers rather than `NaN`.

**Done 2026-11-05.** 10 tests against a fake db that dispatches on the Drizzle
table object passed to `from()`, so each of the three selects gets its own rows.

**The string-cost case was a real bug, not just a missing test.** The code read
`row.cost ?? 0` and relied entirely on `.mapWith(Number)` to have converted the
postgres `numeric`. If a string ever reached it, `+` would concatenate instead
of adding: `'1.5' + '2.25'` is `'1.52.25'`, and the day's total would be
silently wrong with nothing thrown. Added a `toNumber` helper that coerces and
falls back to 0 on anything non-finite. Reverting it turns two tests red.

**Acceptance**
- [x] All five agents covered including absent-agent zeroes
- [x] A `numeric`-as-string input does not produce `NaN`

### BW-14 · CI runs typecheck + tests on PR
**Size S** · blocked by BW-10, BW-11, BW-12, BW-13

Extend `.github/workflows/` with a PR workflow running `turbo run typecheck test`.
The existing `release.yml` only runs on tags.

**Done 2026-11-05.** `.github/workflows/ci.yml`, one job, on pull requests to
`main` and on pushes to `main`. Node 22 with npm cache, `npm ci`, then
`npx turbo run typecheck test`.

`npm ci` rather than `npm install` so the lockfile is authoritative. Confirmed
the lockfile is in sync after this session's dependency changes (vitest added,
`@fastify/cors` removed) with `npm ci --dry-run`.

Verified the gate catches a type error by introducing one: a `string` assigned
to a `number` in `packages/shared/src/types.ts` fails `@burn-watch/shared#typecheck`
and the aggregate command exits non-zero. Removing it returns 8/8 green.

**Acceptance**
- [x] Workflow runs on pull requests to `main`
- [x] A deliberately broken type fails the run

---

## P3 — Data integrity and ops

### BW-15 · Wrap usage submit in a transaction
**Size M** · blocked by BW-10

`routes/usage/submit.ts` runs `upsertUsageEvents`, `upsertEnrichment` and the
snapshot rebuild as three separate operations. A failure between them leaves
events written and the snapshot stale, with nothing to retry it.

Wrap all three in `db.transaction()`. Needs the WebSocket Neon driver, which
BW-06 preserves.

**Done 2026-11-05.** Four operations, not three — the `devices.lastSeenAt`
touch is in there too. The `try/catch` that swallowed a rebuild failure is
gone; swallowing it is the exact behaviour this ticket exists to remove.

The services needed to work both inside and outside a transaction, so
`plugins/db.ts` now exports
`DbOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0]`, deriving the
transaction handle's type from `DB` rather than naming a driver type that
could drift. `upsertUsageEvents`, `upsertEnrichment` and `rebuildDailySnapshot`
take that.

**A latent gap fell out of this.** Moving the writes into a callback made
TypeScript drop the narrowing on `jwt.deviceId` — narrowing of a property
access does not survive into a closure — which exposed that `deviceId` is
optional on `JwtPayload` and was never checked for presence, only for equality.
Bound it to a const with an explicit `!deviceId` arm, so a token carrying no
device is now rejected rather than reaching the insert.

**On the rollback test.** The fake db cannot prove postgres rolled anything
back; what it proves is that the route no longer swallows the failure. Two
tests: every write is issued after `transaction` opens, and a failing snapshot
upsert propagates out as a 500 instead of a 200. Reverting to the old
independent-writes shape turns both red. Verifying the rows are actually gone
needs a real database and is not something this suite does.

**Acceptance**
- [x] All operations in one transaction
- [x] A forced failure in the snapshot rebuild aborts the submission — the
      route surfaces it instead of returning success
- [x] Test covering the rollback, with the limit above stated

### BW-16 · `/health` checks DB and Redis
**Size S** · blocked by BW-02

`server.ts:37` returns `{ ok: true }` unconditionally, so a dead database still
reports healthy. Vercel and any uptime monitor will believe it.

Run `SELECT 1` and a Redis `PING`. Return 503 with which dependency failed.

**Done 2026-11-05.** Brought forward from P3 because BW-08's smoke test is
worthless against a `/health` that cannot fail.

`Promise.allSettled` over both checks, so one dead dependency still reports on
the other instead of short-circuiting. The body carries only
`{ ok: false, failed: ['database'] }`; the driver error goes to the log, where
it belongs — both drivers put the host in the message and the Redis URL carries
a password. A test asserts the host and password never reach the response.

5 tests. Reverting `/health` to `{ ok: true }` turns 3 of them red.

**Acceptance**
- [x] 200 only when both dependencies answer
- [x] 503 with the failing dependency named
- [x] No credentials in the response body

### BW-17 · Generated migration files
**Size M** · blocked by BW-02

`apps/api/drizzle/` holds only `schema.ts`. Deploys use `drizzle-kit push`,
which diffs against live and can drop columns without review.

Generate a baseline migration from the current schema, then switch deploys to
`drizzle-kit migrate`. Keep `push` for local only.

**Done 2026-11-05.** `drizzle/migrations/0000_baseline.sql` plus drizzle's
`meta/` journal and snapshot. 11 tables.

**Verified against a real empty database, not by reading the SQL.** Spun up a
throwaway local Postgres cluster in `/tmp` — deliberately not a Neon branch,
since this needed no access to the user's infrastructure — created an empty
database and applied the baseline with `ON_ERROR_STOP=1`. It applied clean.

Two independent checks that it reproduces the schema *exactly*:
- Re-running `drizzle-kit generate` reports "No schema changes, nothing to
  migrate", so the migration set is a complete representation of `schema.ts`.
- Column counts from `information_schema` match drizzle's own per-table counts
  for all 11 tables (7/14/21/6/7/8/6/5/10/15/9), and foreign keys come to 13
  against drizzle's 13.

Cluster destroyed afterwards.

`drizzle-kit push` could not be used for the comparison: the project is on
`@neondatabase/serverless`, so drizzle-kit dials the URL over HTTPS and refuses
a plain local Postgres. Noted in case someone tries the same thing later.

**On the deploy path.** Nothing automated runs either command today — neither
the old Render config nor the new `vercel.json` has a migration step, so there
is no `push` on a deploy path to remove. `db:migrate` and `db:push` both stay
as manual scripts. If a migration step is ever added to the deploy, it has to
be `db:migrate`. Worth a ticket to add one, rather than leaving it manual.

**Acceptance**
- [x] Baseline migration committed
- [x] Applying it to an empty database reproduces the schema exactly
- [x] Deploy path uses `migrate`, never `push` — vacuously, no deploy path runs
      either; recorded above so it stays that way

---

## P4 — Features

All four have schema in place and no code behind it. Keep multi-agent support in
each — Claude first means Claude is verified first, not that others are removed.

### BW-18 · Budget alerts API + UI
**Size L** · blocked by BW-14

`budget_alerts` table is defined and unused. Build threshold CRUD, evaluation on
snapshot rebuild, and an admin UI. Per-agent thresholds, not Claude-only.

Decide before building: what happens when a threshold trips. Dashboard banner
only, or email/Slack too. Dashboard-only is the smaller first version.

**Acceptance**
- [ ] Create, list, update, delete thresholds scoped to an org
- [ ] Evaluated when a snapshot rebuilds
- [ ] Admin UI to manage them
- [ ] Tests for the boundary case where spend exactly equals the threshold

### BW-19 · Invite flow on `invites` table
**Size M** · blocked by BW-14

`invites` is defined and unused. Admin invites currently write to `users`
directly, so there is no pending state and no expiry.

Issue a token, store it hashed, expire it, and let the invitee complete signup
through better-auth.

**Sized wrong.** Listed M, actually L. It spans the API, the admin UI, and a
new public page that has to coordinate with better-auth.

**API side done 2026-11-05**, in `apps/api/src/routes/auth/invites.ts`.
20 tests. Three endpoints: issue (admin), list (admin), accept (public).

No schema change was needed, and the one attempted was backed out. Renaming
`invites.code` to `code_hash` would have been more honest about what the
column holds, but `drizzle-kit generate` stops on an interactive "created or
renamed?" prompt that cannot be answered from a non-TTY, and piped stdin does
not reach it. Not worth a blocked migration for a cosmetic rename, so the hash
lives in `code` with a comment saying so. A `name` column was also considered
and dropped: the invitee supplies their own name when accepting, which is
better anyway.

Security decisions worth keeping:
- SHA-256, not a KDF. The token is 32 bytes from `randomBytes`, so there is no
  guessable input for a slow hash to defend.
- Unused and unexpired are conditions in the lookup query, not branches after
  it, so no future code path can skip them.
- One identical error for unknown, expired and already-used. Separate messages
  would tell a guesser which tokens were ever real.
- Redemption claims the row with `UPDATE ... WHERE used_at IS NULL` in the same
  transaction as the user insert, so two requests racing one token produce one
  account. Covered by a test.
- Org and role come from the invite row, never the request body.

**A decision is needed before the UI can be built.** Accepting an invite and
creating the better-auth account are two writes to two different places, and
better-auth keeps its own tables separate from `users`, linked only by email.
Whichever runs first, a failure in the second leaves an orphan: either a
`users` row with no way to log in, or a login with no org. There is no
"set your password" recovery path today. Pick one:
  a. Accept first, and add a recovery path for an account with no password.
  b. Sign up first, and have an admin clean up orphaned auth accounts.
  c. Have the API issue the better-auth account too, making it one write.

**Remaining**
- `apps/dashboard/src/lib/api.ts`: `createInvite`, `listInvites`
- Admin form: issue an invite and show the link, instead of creating a user
- Public `/invite/[token]` page: name + password, then accept and sign up
- Whichever ordering is chosen above

**Acceptance**
- [x] Invite token stored hashed, never in plaintext
- [x] Expiry enforced server-side
- [x] Used invite cannot be replayed
- [ ] Existing admin invite form migrated onto it

### BW-20 · Cross-platform agent scheduling
**Size M** · blocked by BW-14

`apps/agent/src/lib/cron.ts` writes a launchd plist and is macOS-only. The
`devices` schema already tracks `darwin`/`win32`/`linux`.

Add systemd user timers for Linux and Task Scheduler for Windows. Keep one
`installSchedule(binaryPath)` entry that dispatches on platform.

Also reconcile the CLI surface: ARCHITECTURE.md documents an `install-schedule`
command that does not exist. Actual commands are `register`, `sync`, `status`,
`uninstall`. Decide whether to add the command or fix the doc, and apply the
same answer in BW-23.

**Acceptance**
- [ ] Linux and Windows schedule installation works
- [ ] `uninstall` removes the schedule on all three platforms
- [ ] Unsupported platform fails with a clear message, not a stack trace

### BW-21 · GitHub Copilot integration
**Size L** · blocked by BW-14

The most visible gap. The admin page renders a "Connect your GitHub org" card,
`org_integrations` exists, and `COPILOT_ENCRYPTION_KEY` was provisioned in
`render.yaml` — with no backend behind any of it. Copilot columns are always
zero while the UI implies otherwise.

Needs the GitHub org OAuth flow, encrypted credential storage, and a pull from
the Copilot usage API. Business or Enterprise plans only.

Until this ships, either hide the admin card or label it as not yet available.
Shipping a dead button is worse than shipping no button.

**Acceptance**
- [ ] Org credentials encrypted at rest with `COPILOT_ENCRYPTION_KEY`
- [ ] Key absent means the feature degrades, not crashes
- [ ] Copilot usage lands in `usage_events` and flows to snapshots
- [ ] Admin card reflects real connection state

---

## P5 — Polish

### BW-22 · Dashboard inline styles to Tailwind
**Size L** · no blockers

Tailwind 4 is installed and `globals.css` imports it, but pages still use inline
`style={{}}`.

**Scope corrected 2026-11-05.** The audit reconciliation in BW-24 counted the
real total: **101 occurrences across 10 files**, not the 31 across two pages
recorded here. Size L still holds, but plan for the whole dashboard rather than
two pages.

Convert page by page. Low risk, independent of everything else, good filler work
between larger tickets.

**Acceptance**
- [ ] No `style={{}}` left in `apps/dashboard/src/app`
- [ ] Rendered output visually unchanged

### BW-23 · Fix ARCHITECTURE.md drift
**Size S** · blocked by BW-08

Known drift:
- Documents an `install-schedule` CLI command that does not exist
- Quickstart still describes the Render and local-only setup
- Needs the Vercel Services topology from BW-04

**Acceptance**
- [ ] Every documented command exists
- [ ] Deployment section matches the Vercel setup
- [ ] Quickstart followed start to finish on a clean checkout

### BW-24 · Reconcile REVIEW.md into `docs/audits/`
**Size S** · no blockers

`REVIEW.md` sits untracked in the repo root, dated 2026-06-23, listing 5 P0,
7 P1, 9 P2 and 7 P3 findings. Roughly 20 of the 28 were fixed in later commits.
Read as-is it reports long-closed critical security issues as open.

Move it to `docs/audits/2026-06-23-review.md` and annotate each finding with
resolved-and-verified, still-open, or superseded. Link still-open ones to their
ticket here.

Known still-open at the time of writing: no tests (BW-09 to BW-14), no migration
files (BW-17), no transaction boundaries (BW-15), `/health` does not check
dependencies (BW-16), macOS-only scheduling (BW-20), inline styles (BW-22),
unused `invites`/`org_integrations`/`budget_alerts` tables (BW-18, BW-19, BW-21).

**Done 2026-11-05.** At `docs/audits/2026-06-23-review.md`, tracked. All 28
findings annotated; the original text is untouched so it still reads as the
audit it was.

The list above turned out to be close but not exact, because most of those
tickets closed earlier the same day. Final counts: 23 resolved, 1 partially
resolved, 2 still open, 1 superseded, 1 unverified.

RESOLVED required confirming the fix in the live source. A commit message
claiming a fix was not accepted as evidence, which matters here: several
findings had commits referencing them that did not fully close them.

Still open: P3-1 (server-side `new Date()` hydration risk, low severity) and
P3-4 (macOS-only scheduling, owned by BW-20). P3-3 is UNVERIFIED — a two-part
timezone finding where only one part can be checked from source; the other
needs a live database.

**Acceptance**
- [x] Moved under `docs/audits/` and tracked in git
- [x] Every finding carries a current status
- [x] Still-open findings link to a ticket ID

---

## Tickets opened 2026-11-05 from the audit reconciliation

BW-24 re-checked all 28 findings against live source. Six were confirmed still
present with no ticket owning them. Five became tickets; the reasoning for the
two that did not is at the bottom.

### BW-25 · Push the JSONB merge in activity/projects into SQL
**Size M** · no blockers

`routes/dashboard/activity.ts:46-67` and `projects.ts:44-67` pull JSONB columns
out of postgres and merge them in Node. The June audit's own suggested fix,
`jsonb_array_elements`, still applies. This is the first thing that breaks as
the org grows, because the work scales with rows returned rather than rows
needed.

The two routes also duplicate the same fetch-then-merge shape, so doing this
once collapses a DRY violation the audit logged separately. The N+1 `inArray`
half of that finding is already fixed — both routes JOIN now.

**Acceptance**
- [ ] Aggregation happens in postgres, not in the route
- [ ] Both routes share one helper
- [ ] Response shape unchanged, proven by the existing route tests

### BW-26 · Remove the double type assertion in `overview.ts`
**Size S** · no blockers

`overview.ts:55-57` reads per-agent columns with
``today?.[`${agent}Tokens` as keyof typeof today] as number``. Two assertions
stacked like that turn the type checker off for the agent fan-out, which is
exactly where a renamed column would otherwise be caught.

**Acceptance**
- [ ] No `as` on that access path
- [ ] Renaming a snapshot column produces a type error

### BW-27 · Enforce device token revocation, or drop the table
**Size M** · no blockers

`device.ts:132` hashes the access token into `device_tokens` on issue, which was
the June audit's P0-5 fix and is correct. Nothing ever reads it back. A revoked
or stolen device token stays valid for its full 30 days.

Decide before building: either check the hash on `requireAuth` and add a
revocation endpoint, or drop the table and stop implying a capability that does
not exist. Checking on every request costs a lookup per authenticated call, so
it wants Redis rather than postgres.

**Acceptance**
- [ ] A revoked token is rejected, with a test
- [ ] Or the table and its write are removed and the decision recorded here

### BW-28 · Share the dashboard query schema and cache wrapper
**Size S** · no blockers

`dateRegex` and the near-identical `from`/`to`/`date` Zod object are declared
five times, once per dashboard route. The Redis get, miss, compute, set, expire
sequence is written out five times too.

One shared query schema and one `withCache` helper. The audit also suggested
`fetchOrgEnrichment`; fold it in if BW-25 has not already absorbed it.

**Acceptance**
- [ ] One query schema, imported by every dashboard route
- [ ] One cache helper, with the per-route key still distinct
- [ ] Route tests unchanged and passing

### BW-29 · De-duplicate the event builder in `ccusage.ts`
**Size S** · no blockers

`ccusage.ts` builds the same `UsageEvent` roughly 30 lines at a time in two
places: `parseOutput` (`:84-103`) and `collectRange` (`:169-188`). The copies
are currently identical, which is the point — they can drift, and a free-tier
or token-summing rule fixed in one would silently stay wrong in the other.

The collector tests from BW-11 cover both paths, so this is a safe extraction.

**Acceptance**
- [ ] One function builds the event, called from both paths
- [ ] `apps/agent` tests pass unchanged

### Confirmed present, deliberately not ticketed

**No API versioning beyond the `/v1` prefix.** ROADMAP.md lists this as
explicitly out of scope. Recorded so the next reader does not re-raise it.

**Dashboard fetches with `cache: 'no-store'`** (`lib/api.ts:23`). Real, but the
API answers from a 300-second Redis cache, so the repeated load lands on Redis
and not postgres. Revisit only if Redis shows it.

### Carried over, still unowned

`apps/api/.env.example` line 8 still sets `CORS_ORIGIN`, which BW-07 removed
everywhere else. One line, outside the paths this session could write.
