# BurnWatch Tickets

**Board updated:** 2026-11-04
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
| BW-04 | P1 | Vercel Services config | **done** | M | BW-03 |
| BW-05 | P1 | Rate limit onto Redis store | **done** | S | — |
| BW-06 | P1 | Reuse DB and Redis clients across warm invocations | **done** | S | — |
| BW-07 | P1 | Env migration, delete `render.yaml` | **doing** | S | BW-04 |
| BW-08 | P1 | Deploy and smoke test | **blocked** | M | BW-05, BW-06, BW-07 |
| BW-09 | P2 | Vitest harness + turbo `test` task | **done** | S | BW-02 |
| BW-10 | P2 | API route tests (auth, org-scoping, dedup) | **done** | L | BW-03, BW-09 |
| BW-11 | P2 | Agent collector tests | **done** | M | BW-09 |
| BW-12 | P2 | Shared Zod schema tests | **done** | S | BW-09 |
| BW-13 | P2 | Snapshot aggregation tests | **done** | M | BW-09 |
| BW-14 | P2 | CI runs typecheck + tests on PR | **done** | S | BW-10, BW-11, BW-12, BW-13 |
| BW-15 | P3 | Wrap usage submit in a transaction | **done** | M | BW-10 |
| BW-16 | P3 | `/health` checks DB and Redis | **done** | S | BW-02 |
| BW-17 | P3 | Generated migration files, stop `db:push` on prod | **done** | M | BW-02 |
| BW-18 | P4 | Budget alerts API + UI | todo | L | BW-14 |
| BW-19 | P4 | Invite flow on `invites` table | todo | M | BW-14 |
| BW-20 | P4 | Cross-platform agent scheduling | todo | M | BW-14 |
| BW-21 | P4 | GitHub Copilot integration | todo | L | BW-14 |
| BW-22 | P5 | Dashboard inline styles to Tailwind | todo | L | — |
| BW-23 | P5 | Fix ARCHITECTURE.md drift | todo | S | BW-08 |
| BW-24 | P5 | Reconcile REVIEW.md into `docs/audits/` | todo | S | — |

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

**Acceptance**
- [x] `redisPlugin` registered before `rateLimit`
- [x] Rate limit configured with the Redis store
- [x] Limit survives across two separate server instances sharing one Redis
- [x] Per-route `config.rateLimit` values unchanged

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

**Acceptance**
- [x] Pool and Redis client created once per module, not per registration
- [x] Still on the WebSocket Neon driver
- [ ] No connection-exhaustion warnings in Neon after a load pass — recheck
      after BW-08, needs real traffic

### BW-07 · Env migration, delete `render.yaml`
**Size S** · blocked by BW-04

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

**Acceptance**
- [ ] All required env vars set in Vercel for production and preview — BW-08
- [x] `render.yaml` deleted
- [x] `.npmrc` kept
- [x] CORS decision applied — plugin, guard and dependency all removed

### BW-08 · Deploy and smoke test
**Size M** · blocked by BW-05, BW-06, BW-07

First confirmed-green deploy. The last attempt was pushed 2026-06-25 and never
verified.

**2026-11-05 — builds and routes. Blocked on environment variables.**

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
- [ ] Both services build and deploy
- [ ] `/health` returns 200 on the deployed domain
- [ ] Dashboard login works end to end against the deployment
- [ ] One authenticated query per dashboard page returns real data
- [ ] Agent `sync` against the deployed API writes a row
- [ ] Record the production URL in ROADMAP.md

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

Use `buildServer()` from BW-03 with `app.inject()`. Mock `fastify.db` and
`fastify.redis` decorators.

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

**Acceptance**
- [ ] Invite token stored hashed, never in plaintext
- [ ] Expiry enforced server-side
- [ ] Used invite cannot be replayed
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
`style={{}}` — 12 occurrences on the overview page, 19 on the leaderboard.

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

**Acceptance**
- [ ] Moved under `docs/audits/` and tracked in git
- [ ] Every finding carries a current status
- [ ] Still-open findings link to a ticket ID
