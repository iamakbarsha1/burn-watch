# BurnWatch Tickets

**Board updated:** 2026-11-10
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
| BW-18 | P4 | Budget alerts API + UI | **done** | L | BW-14 |
| BW-19 | P4 | Invite flow on `invites` table | **done** | L | BW-14 |
| BW-20 | P4 | Cross-platform agent scheduling | **done** | M | BW-14 |
| BW-21 | P4 | GitHub Copilot integration | **in progress** | L | operator (plan only) |
| BW-22 | P5 | Dashboard inline styles to Tailwind | **done** | L | — |
| BW-23 | P5 | Fix ARCHITECTURE.md drift | **done** | S | BW-08 |
| BW-24 | P5 | Reconcile REVIEW.md into `docs/audits/` | **done** | S | — |
| BW-25 | P3 | Push the JSONB merge in activity/projects into SQL | **done** | M | — |
| BW-26 | P5 | Remove the double type assertion in `overview.ts` | **done** | S | — |
| BW-27 | P3 | Enforce device token revocation | **done** | M | — |
| BW-28 | P5 | Share the dashboard query schema and cache wrapper | **done (half void)** | S | — |
| BW-29 | P5 | De-duplicate the event builder in `ccusage.ts` | **done** | S | — |
| BW-30 | **P0** | `verify-device` has no approval gate — self-service device tokens | **done** | M | — |
| BW-31 | P4 | Agent default `--api-url` pointed at a domain that never existed | **done** | S | — |
| BW-32 | P4 | launchd plist named the runtime, not the burnwatch binary | **done** | S | — |
| BW-33 | P4 | Copilot usage silently dropped by the ccusage collector | **done** | S | — |
| BW-34 | **P2** | Agent never collects project breakdown and cache stats | **done** | M | — |
| BW-35 | P3 | Projects "Users" column counts rows, not users | **done** | S | BW-34 |
| BW-36 | P5 | Sidebar shows the Admin link to every role | **done** | S | — |
| BW-37 | **P0** | Database never migrated — `tripped_at` missing in production | **done** | M | — |
| BW-38 | P4 | `register` overwrites an existing agent config silently | **done** | S | — |
| BW-39 | P4 | Setup instructions are macOS-only, and Windows could never collect | **done** | M | BW-20 |
| BW-40 | P4 | Every developer has to install Bun and build from source | **done** | M | BW-39 |
| BW-41 | **P2** | Concurrent rebuilds overwrite a daily snapshot with stale totals | **fixed 2026-11-10** | S | — |
| BW-42 | P3 | `npm ci` installs the agent from a stale lockfile entry | **open** | XS | — |

---

## Verification debt

Carried deliberately. Each of these is code that passes its tests but has not
been exercised on the surface that would actually prove it. Listed so none of
them reads as done.

| From | What is unproven | What would settle it |
|------|------------------|----------------------|
| BW-21 | Every call to GitHub. The seats walk, the report download, the NDJSON record shape, and whether a fine-grained PAT with "GitHub Copilot Business" read actually reaches these endpoints. All of it runs on fixtures built from the published schema. | A Copilot Business or Enterprise org to point `POST /v1/integrations/copilot/sync` at. Nothing smaller settles it; the endpoints do not exist on other plans. |
| BW-21 | The admin panel's **connected** states. Three of five were walked in a browser on 2026-11-10 (see below); connected, and a sync returning unmatched logins, were not, because reaching them needs a real org. The seat section, the idle dollar figure, the unlinked and ambiguous callouts have never rendered with data. | The same Copilot Business org the row above needs. Everything short of that stops at the connect form. |
| BW-21 | Report lag. The sync defaults to yesterday because GitHub publishes no cutoff for when a day's report appears, and a 404 is read as "not generated yet". Whether yesterday is reliably available is a guess. | One run against a real org, then a second the next morning, comparing which days returned rows. |

**Partly cleared 2026-11-10, BW-21's panel.** Signed in as `akbar@test.com`
against a Neon branch copied from production, with the API and dashboard run
locally and pointed at it. Three of the five states rendered, zero console
errors:

- API unreachable. "Could not read the Copilot integration status", and it says
  the rest of the page is still accurate rather than leaving the reader to
  guess.
- Key present but unusable. "Cannot be configured",
  `COPILOT_ENCRYPTION_KEY is set but unusable`, and the remedy named down to
  `openssl rand -base64 32`. This is the state the three-way encryption split
  was built for, and it is the one a collapsed "unavailable" would have ruined.
- Encryption ready, not connected. "Not connected" with the connect form, and
  the seat section correctly absent, which is the gating claim checked rather
  than taken on trust.

The route was also exercised over real HTTP against that branch, not through
the test harness: 503 carrying the encryption reason, 404 when not connected,
200 from `/status` reporting `encryption: ready`, and 400 from Zod for
`idleAfterDays=9999`.

**Noted while there, not changed.** `CopilotPanel.tsx:144` tells the admin to
use a token with the `manage_billing:copilot` scope. That is a classic-PAT
scope, while this ticket's unblocking note settled on a fine-grained PAT with
"GitHub Copilot Business" read. Both may reach the endpoint; the point is that
the panel and the ticket give different instructions, and operator-facing setup
copy should not be rewritten from memory. It predates the seat roster, arriving
in `0e3b376`. Settle it against GitHub's current docs when the org above
exists, since that is the run that proves which token actually works.

**Cleared 2026-11-10.** BW-20's Windows and Linux debt, and with it BW-40's
last box. Settled on GitHub's `ubuntu-latest` and `windows-latest` runners —
real VMs with a real systemd and a real Task Scheduler, reached by
`.github/workflows/verify-install.yml` after four sessions of treating "no
Linux or Windows hardware here" as the end of the road. Docker was never the
only option; the CI provider had been sitting there the whole time.

| From | How it was settled |
|------|--------------------|
| BW-20 | Installed v0.2.1 by the documented `curl \| sh` and `irm \| iex` one-liners, ran `install-cron`, and asked each OS. Linux: `burnwatch-sync.timer` is `loaded … enabled`, `Active: active (waiting)`, `Trigger: 18:00:00 UTC; 11h left`. Windows: `\BurnWatchSync`, `Status: Ready`, `Scheduled Task State: Enabled`, `Schedule Type: Daily`, `Start Time: 6:00:00 PM`, `Task To Run: …\burnwatch.exe sync`. |
| BW-40 | `install.ps1` executed on real Windows for the first time. It downloads, verifies the checksum, installs to `~\.local\bin`, and appends to the user PATH. The run also caught two defects that made v0.2.0 uninstallable — see below. |

**What the verification caught.** v0.2.0 was broken on both platforms and
nobody knew, because nobody had installed it:

- `schtasks` rejected the task XML with `(1,2)::ERROR: one root element`.
  Node's `utf16le` writes no byte order mark and `schtasks` requires one, so
  `install-cron` scheduled nothing on every Windows machine. The five existing
  unit tests asserted the XML string and could not see the encoding. Fixed in
  `473d862`, with two tests on the bytes.
- `install.sh` refused the Linux binary: the published `checksums.txt` carried
  a hash from a different build than the uploaded asset. `release.yml` built
  three targets and generated no checksums at all, so v0.2.0's Windows binary
  and checksum file had both been added by hand. The workflow now builds all
  four targets and hashes the same files it uploads.

**Cleared 2026-11-06.** Both were cleared by doing the thing the right-hand
column asked for, and one of them was worth every minute:

| From | How it was settled |
|------|--------------------|
| BW-36 | Signed in as `verify-dev@test.com`, a genuine `developer` row in a Neon branch copied from production, with no stub anywhere. Neither nav renders Admin — the vertical sidebar at 1440px and the compact header nav at 390px — and navigating to `/admin` directly redirects to `/`. The link is hidden *and* the page refuses. |
| BW-23 | Walked on a fresh `git clone` into an empty directory, against an empty database. Three of the eight steps failed; the Quickstart is rewritten to twelve. Details under BW-23 below. |
| BW-18 | Drove the panel in a browser as a real admin. It did not work: three defects, one of them a production outage nobody had noticed. Written up in full under BW-18, and the database half is now BW-37. The debt was load-bearing. |

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
- [x] ~~`vercel dev` runs both services locally~~ void — BW-08 replaced
      Services with two projects, so there are no services for `vercel dev` to
      run. Local dev is `npm run dev` in each app.

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
- [ ] No connection-exhaustion warnings in Neon after a load pass — still
      open, and deliberately not ticked. Measured on production 2026-11-06:
      13 connections against a `max_connections` of 901, 6 of them client
      backends. That is an idle snapshot, not a load pass, and it cannot
      distinguish "the module-scoped pool works" from "nobody is using it" —
      ingestion had been down for 22 hours (BW-37) and the dashboard has a
      handful of users. What would settle it is concurrent submissions from
      several agents at once, which is what the fleet rollout produces
      anyway. Worth rechecking then rather than manufacturing load against
      production now.

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

**Acceptance** (restated for Render, then outlived by it)
- [x] ~~The four API env vars set on the Render service~~ void — Render was
      abandoned the same session and `render.yaml` is deleted. The equivalent
      Vercel vars are listed at the top of this ticket.
- [x] `BETTER_AUTH_SECRET` and `API_URL` set on the Vercel dashboard project —
      both set; `API_URL` points at `https://burn-watch-api.vercel.app`
- [x] `render.yaml` rewritten for the real build — `npx turbo build` then
      `node apps/api/dist/src/server.js`, not `npx tsx` on source
- [x] `.npmrc` kept
- [x] CORS decision applied — plugin, guard and dependency all removed, and the
      justifying comment no longer rests on a shared origin
- [x] `apps/api/.env.example` no longer ships dead keys. All three went on
      2026-11-10: `CORS_ORIGIN` (CORS removed in this ticket), `REDIS_URL`
      (Redis dropped in BW-08, and the architecture doc already said "There is
      no REDIS_URL" two sections above the setup steps) and
      `COPILOT_ENCRYPTION_KEY` (nothing has read it since BW-07 deleted
      `render.yaml`; BW-21 would provision it fresh). The file now lists only
      what `build-server.ts`, `plugins/db.ts` and `server.ts` actually read:
      `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PORT`, `NODE_ENV`.

      The path is behind a deny rule, so the agent could not do it and said so
      in the neighbouring doc instead — which is how a ten-second edit stayed
      open for four days across two sessions. Handing over the exact command
      took one line and closed it.

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
- [x] Agent `sync` against the deployed API writes a row — smoke-tested
      2026-11-05 end to end: `register-device` → `verify-device` → config →
      `sync --date 2026-11-04` → `Accepted: 4`, and four `usage_events` rows for
      device `16db583a` confirmed in Neon (opus-5 $54.33, sonnet-5 $3.56,
      sonnet-4-6 $3.37, haiku-4-5 $1.43)
- [x] Device tokens are correctly refused by the dashboard API — all five
      dashboard routes return 403 `Dashboard access requires user role` for a
      device-role JWT, so a stolen agent token cannot read spend data
- [x] Dashboard login works end to end against the deployment
- [x] One authenticated query per dashboard page returns real data

The last two cannot be closed from a terminal. Dashboard reads need a
**user**-role JWT, and that is minted only by `createApiTokenForEmail` in
`lib/session.ts`, which signs with `JWT_SECRET` from inside the deployed
dashboard after a better-auth login. There is no path to it without either
browser credentials or the secret. The dashboard also sits behind Vercel SSO.
Closing these means someone logging in and loading the pages.

The smoke test also found BW-30, which is a P0.
- [x] Promote to production and record both URLs in ROADMAP.md — done
      2026-11-06; the dashboard's usable alias is `burn-watch-delta.vercel.app`
      (307 to `/login`), not the SSO-gated `-akbar-sha-ss-projects` one

**On the two unticked lines above, 2026-11-06.** Both were proven locally
today against a Neon branch copied from production: better-auth login end to
end, and every dashboard page rendering real figures — Overview reads
`$3,038.53` and `5.0B` tokens from the branch, not from a fixture. That is not
the same claim as the deployment serving them, which still needs someone with
credentials to sign in at `burn-watch-delta.vercel.app`. Left unticked
deliberately: a local pass is evidence about the code, not about the deploy.

Both projects were redeployed from `main` on 2026-11-06 after the BW-18 fixes,
so the deployment now carries them — but that only moves the question, it does
not answer it. Closing these two needs a person with a password.

**Closed 2026-11-10.** The password existed all along — `akbar@test.com` was
reset on 2026-11-06 and written down; the previous session's note that nobody
held one was simply out of date. Signed in at `burn-watch-delta.vercel.app`
against the real deployment and loaded all eight pages. Every one returned
production data, not an empty state:

| Page | What came back |
| --- | --- |
| Overview | `$3,038.53`, 5.0B tokens, five agents with Qwen flagged free tier |
| Leaderboard | Akbar Sha, `$3,038.53`, 19,205 sessions |
| Trends | daily spend 03-26 to 11-05, Claude peak `$303.31` |
| Activity | 26,317 calls across 399 distinct tools |
| Projects | per-project cost, top row `al-sorat` at `$450.58` over 406 sessions |
| Devices | four registered devices, approval form present |
| Admin | 5 members, 3/5 with the agent installed, 0 open invites |
| Setup | the BW-40 one-line installer, live |

The lesson is cheaper than the delay: the blocker was recorded as "nobody has
credentials" and never rechecked after credentials were created in the very
next session.

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

**Settled: dashboard banner only.** It appears on `/admin`, above the panel.

**Built 2026-11-05/06**, merged in `4745f9d`. **Verified in a browser
2026-11-06**, against a Neon branch taken from production, signed in as a real
admin — and the verification is the only reason this ticket is honest, because
the panel did not work. Three defects, none of which any test caught:

1. **The column was never in the database.** `0004_budget_alert_tripped_at.sql`
   was generated and committed, and nothing ever ran it. Creating an alert
   answered `column "tripped_at" of relation "budget_alerts" does not exist`.
   This is not local: the branch was copied from production, so production had
   the same gap. See BW-37 — the database has no `drizzle.__drizzle_migrations`
   table at all, because it was built with `push` and has never been migrated.

   **Read BW-37 before believing this line.** "Creating an alert fails" is what
   the panel showed and it is the smaller half of the truth. The same missing
   column took down `POST /v1/usage/submit` for every agent for about 22 hours,
   because the submit transaction evaluates budget alerts and that evaluation
   selects the column even when no alert rows exist. A browser session driving
   one feature could not see that; it took a `sync` pointed at production.
2. **Every delete returned 400.** `apiMutate` in the dashboard's `lib/api.ts`
   set `Content-Type: application/json` on every request including the
   bodyless ones, and Fastify rejects an empty body that claims to be JSON
   before it reaches a route. Fixed by only declaring the type when there is a
   body — one guard in the shared function, so no future bodyless verb repeats
   it. Pinned by `apps/dashboard/src/lib/api.test.ts`.
3. **The status contradicted the spend beside it.** `evaluateBudgetAlerts` was
   only ever called from the usage-submit path, so an alert created or edited
   with a limit under current spend read `OK` next to the month-to-date figure
   that disproved it, until the next agent sync. Fixed with
   `evaluateBudgetAlert`, called by both the create and update routes.

Defect 2 is why defect 3 survived review: the panel discarded the delete
action's result, so a failing write and a succeeding one rendered identically.
That is fixed too — a failed delete now says so.

Verified after the fixes, in the browser: create, list, edit, delete all round
trip; `$554.22` against a `$400` limit at 50% flips to **Tripped** on save and
back to **OK** when the limit is raised past spend; the banner reads "1 budget
alert has tripped this month" and appears on create, which only works because
the write now evaluates.

**Acceptance**
- [x] Create, list, update, delete thresholds scoped to an org — all four
      driven in a browser, not just through the route tests
- [x] Evaluated when a snapshot rebuilds, and now on every CRUD write too
- [x] Admin UI to manage them
- [x] Tests for the boundary case where spend exactly equals the threshold —
      `$100` at threshold 1 trips at exactly `$100`; flipping `>=` to `>`
      turns it red

**Known limit.** The banner is on `/admin` only. The GET route's comment says
a developer should be able to see why a banner is up, but no banner renders
outside a page developers cannot reach. Either the comment or the placement is
wrong; not resolved here.

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

**Ordering settled 2026-11-06: accept first (a), and the recovery path already
exists.** The choice was never open. `app/api/auth/[...all]/route.ts` answers
403 on `/sign-up/email` unless the email already has an active `users` row, so
sign-up cannot run before the invite is redeemed — (b) and (c) both need that
gate weakened. The orphan the ticket worried about is recoverable as built: if
sign-up fails after the invite is spent, the `users` row exists, which is
exactly the state `/signup` was written for ("set a password for the account
your admin created"). The accept page says so in its error.

**UI side done 2026-11-06.** `createInvite`/`acceptInvite` in
`lib/api.ts`, the admin form issues an invite and shows the link once, and
`/invite/[token]` takes name + password.

Verified in a browser against a throwaway Neon branch, not production:
invite issued, link opened, account created, landed on `/setup` signed in as
the invitee, admin Team went 4 to 5 and the invite row flipped to Accepted.
Replaying the spent link and submitting an unknown token both answer
"Invalid or expired invite", the same string for both.

**Acceptance**
- [x] Invite token stored hashed, never in plaintext
- [x] Expiry enforced server-side
- [x] Used invite cannot be replayed
- [x] Existing admin invite form migrated onto it

### BW-20 · Cross-platform agent scheduling
**Size M** · blocked by BW-14

`apps/agent/src/lib/cron.ts` writes a launchd plist and is macOS-only. The
`devices` schema already tracks `darwin`/`win32`/`linux`.

Add systemd user timers for Linux and Task Scheduler for Windows. Keep one
`installSchedule()` entry that dispatches on platform. It takes no path
argument: BW-32 made `installCron()` resolve its own argv by probing candidates
with the hidden `__self-check` command, and each platform backend needs the same
resolved argv. `resolveSelfCommand()` is platform-independent and stays shared.

The CLI surface is settled, so the existing command names are the ones to keep:
`register`, `sync`, `status`, `install-cron`, `uninstall`. `install-cron` is
macOS-specific in name only; it should dispatch per platform rather than gain a
sibling command. ARCHITECTURE.md now documents this set.

**Done 2026-11-06**, merged in `d7c1ee5`. `backendFor(platform)` dispatches to
one of three `ScheduleBackend` implementations and `installSchedule`,
`uninstallSchedule` and `isScheduleInstalled` are the platform-independent
entry points. `cron-linux.ts` writes a systemd user unit and timer,
`cron-windows.ts` drives `schtasks`.

**Acceptance** — the first three are covered by unit tests that fake
`process.platform`, and by nothing stronger; see the verification debt table
- [x] Linux and Windows schedule installation works — the generated unit and
      XML are asserted, the real `systemctl`/`schtasks` call is not
- [x] `uninstall` removes the schedule on all three platforms — same level
- [x] `install-cron` repoints an existing schedule on all three platforms —
      same level
- [x] Unsupported platform fails with a clear message, not a stack trace —
      this one is fully proven; no real OS is needed to throw a named error

**`build:windows-x64` added 2026-11-06.** The debt table said there was no
Windows build script, which made the Windows half unverifiable even in
principle. `bun build --target=bun-windows-x64` produces a `PE32+ executable
(console) x86-64` — so a binary now exists to carry to a Windows machine. It
has not been run on one.

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

**Blocked on the operator, 2026-11-06.** Two of the inputs this ticket needs
cannot be produced from inside the repo:

1. A GitHub OAuth app registered under the target org, which yields the client
   ID and secret the flow is built around.
2. A Copilot Business or Enterprise plan to pull against. The usage API does
   not exist on other plans, so there is nothing to verify an implementation
   with.

Also note the ticket's own premise is partly stale. It says
`COPILOT_ENCRYPTION_KEY` "was provisioned in `render.yaml`". BW-07 deleted
`render.yaml`, and that key now has zero references anywhere in the
repository. It is not configured on either Vercel project either. Whoever
picks this up provisions it fresh rather than finding it.

The interim was taken instead: the dead "Connect GitHub org" button is gone,
replaced by a "Not yet available" badge that says Copilot figures stay at zero
until the integration exists. That closes the "dead button" harm without
scaffolding an OAuth flow nobody can exercise.

Deliberately NOT built: encrypted credential storage and a connection-state
UI. Both are scaffolding for a flow that cannot be tested, and would have to
be rewritten once the real OAuth shape is known.

**Unblocked 2026-11-10, and two of the premises above are wrong.**

The OAuth app is not required. These endpoints accept a fine-grained PAT with
"GitHub Copilot Business" read or "Administration" read on the org. An org
admin creates one in the GitHub UI and pastes it into the admin page, so
blocker 1 dissolves without registering anything. OAuth exists to let many
orgs self-serve a connection, and BurnWatch serves one company.

Premise correction 1: "Copilot columns are always zero" is false. BW-33 fixed
the collector, and `apps/agent/src/collectors/ccusage.ts:14` maps `copilot`
like any other agent. Production holds 22 copilot rows, 36,006,868 tokens and
$32.12 spanning 2026-05-19 to 2026-07-10. The per-developer Copilot spend this
ticket set out to obtain already arrives through the normal device path.

Premise correction 2: "a pull from the Copilot usage API" names an API that no
longer exists. `GET /orgs/{org}/copilot/usage` was sunset in February 2025 and
`GET /orgs/{org}/copilot/metrics` on 2026-04-02. The replacement is a reports
API whose endpoints return signed `download_links` to NDJSON files rather than
inline JSON.

What the replacement does carry, per user per day, is documented at
`docs.github.com/en/copilot/reference/copilot-usage-metrics/example-schema`.
Real token counts, under `totals_by_client[].token_usage` as
`prompt_tokens_sum` and `output_tokens_sum`, repeated per model inside
`totals_by_client[].totals_by_model[]`. Identity as top-level `user_id` and
`user_login`. The day as top-level `day`. One NDJSON record per user per day,
with every model, client and feature split nested inside it rather than
emitted as separate lines.

What it does not carry is a dollar figure. There is no per-user cost an org
admin can read; the per-user billing endpoint needs that user's own token, not
an admin credential. The only cost signal is top-level `ai_credits_used`, a
float, which GitHub documents as "a metrics signal for analyzing consumption,
not a billed total". One credit is $0.01.

So the org pull can supply real Copilot tokens, and only an approximation of
Copilot cost. It also supplies something ccusage cannot at any accuracy, which
is who holds a seat. An assigned Copilot Business seat costs $19/month whether
or not anyone opens an editor, and an unused seat is waste a spend dashboard
should be the thing that catches.

**Scope set 2026-11-10: both halves.** Seat coverage from
`/orgs/{org}/copilot/billing/seats`, and credit-derived usage from the
`users-1-day` reports written into `usage_events` behind a source
discriminator.

**Double counting is the hazard, and it resolves at read time.**
`rebuildDailySnapshot` sums `total_tokens` and `cost_usd` grouped by agent,
filtered on `(user_id, date)` alone. Two sources writing copilot rows for one
developer on one day would be summed, doubling their Copilot spend. The fix is
a `source` column plus a per-agent preference in the aggregation: where a
developer has ccusage rows for an agent on a date, the org-sourced rows for
that agent are ignored. Resolution sits at read time rather than at write
time on purpose, because write-time skipping gives a different answer
depending on which source synced first, and backfills reorder that routinely.

`device_id` also goes nullable, since an org pull has no device. That forces
the unique constraint to be recreated rather than altered: it is currently a
plain `UNIQUE`, Postgres treats NULLs as distinct, and `onConflictDoNothing`
would therefore never fire for org rows. The new constraint carries `source`
and is `NULLS NOT DISTINCT`, which the database supports (Neon, Postgres 18).

Rejected: a synthetic per-developer "integration device" to satisfy the
existing `NOT NULL`. It needs no migration, but `/devices` renders
`Registered devices (N)` to admins, so it would put a phantom row per
developer into a real screen. A column that admits the truth beats a fake row
that hides it.

**Progress 2026-11-10.** Three slices built and merged on `bw-21-copilot`.
`credential-crypto.ts` seals a credential with AES-256-GCM behind a union a
caller has to narrow before `seal` exists. Migration `0005` adds `source`,
makes `device_id` nullable and rebuilds the unique constraint. `rebuildDailySnapshot`
resolves two sources per agent at read time. `copilot.service.ts` walks the
seats pages and parses the usage NDJSON. None of it has a caller yet; the
route and the admin card are the remaining slices.

The double count is not a theory and neither is the fix. Both were executed
against a Neon branch copied from production, running Postgres 18, after
applying `0005` to it. The `ADD CONSTRAINT` took on real rows. Two identical
org-sourced inserts with a null `device_id` produced one row, the second
returning nothing, which is what proves `NULLS NOT DISTINCT` holds and that
`ON CONFLICT` infers it. With an agent row and an org row on one
developer-day the old aggregation returned 150 tokens and $2.00 for copilot
while the new one returned 50 and $0.50, and claude was identical under both,
which is what proves the preference is per-agent rather than global.

Worth recording because the slice that wrote the constraint could not test
it: local `psql` is 14.19, which predates `NULLS NOT DISTINCT`, and no
container runtime was up. Neon was Postgres 18 the whole time. This is the
same shape as BW-20, where "no Linux or Windows hardware" described the shell
rather than the project.

**Seat coverage delivered 2026-11-10.** The scope gap is closed.
`listCopilotSeats` had been walking the whole roster on every connect and every
sync and keeping two counts from it. `GET /copilot/seats` now returns the
roster itself: who holds a seat, which seats are idle, and what the idle ones
cost per month.

Read live and stored nowhere. A roster is current state rather than a time
series, so a table would hold a copy that disagrees with GitHub between syncs
while GitHub remains the thing that issues seats. No table, no migration, no
column. The cost is a seat walk per request, which is why nothing calls it on
page load.

A seat's relation to BurnWatch is one tagged `status` plus one nullable
`userId`, not a cross product of booleans. Idle is `lastActivityAt` null or
older than `?idleAfterDays=` (1 to 365, default 30). An unknown `planType`
yields a null price and counts into `unpricedIdleSeats` rather than being
guessed, because a wrong dollar figure on a spend dashboard is worse than an
absent one.

Four defects were found reviewing it, and all four are fixed here:

- An unhandled 500 echoed its exception message to the browser. Reads used to
  drop the body, so this only became reachable once a failed read started
  surfacing the API's own words, which it needed to do for the four Copilot
  failures that each have a different remedy. The handler now passes a message
  through below 500 and sends a fixed sentence at or above it. Same class as
  the GitHub-body leak this ticket already fixed once.
- A login two users share was attributed to whichever row the driver returned
  last, silently. It now goes to the lowest `users.id` so two reads agree, and
  the login is reported in `ambiguousLogins` so the pick reads as a tie-break
  rather than a fact. The missing unique index stays its own ticket.
- A seat walk that filled every page returned a truncated roster with no
  signal. It now throws. The cap is 5000 seats and this org has about 50, so
  this guards a changed pagination contract rather than growth.
- Every failure of that walk told the operator their token had expired, which
  after the guard above included a case where GitHub never refused anything.
  The message now splits on whether an HTTP status was recovered, and all
  three call sites log the cause, which none of them did before.
- [ ] Org credentials encrypted at rest with `COPILOT_ENCRYPTION_KEY` — the
      envelope is built and tested, but nothing calls it until the route lands
- [ ] Key absent means the feature degrades, not crashes — holds at the module
      boundary; the admin card still has to show which of the two reasons it is
- [ ] ~~Copilot usage lands in `usage_events` and flows to snapshots~~ amended:
      real tokens and credit-derived cost land in `usage_events` behind
      `source`, one row per developer-day, and ccusage wins wherever both
      sources cover one developer-day
- [ ] Seat coverage pulled and reconciled against BurnWatch users
- [ ] Admin card reflects real connection state
- [x] Interim: the admin card no longer ships a dead button

**Adversarial review, 2026-11-10.** Four reviewers on four model families over
the whole diff. Six findings fixed on the branch, each falsified individually.
The two that justify the exercise on their own: a reviewer probed node and
found `createDecipheriv` accepts a GCM tag of 4 to 16 bytes unless the length
is pinned, and a 4-byte tag decrypts a real credential, which is forgery
resistance of 2^-32 rather than 2^-128 for anyone able to write
`encrypted_token`. And a reviewer caught that every record for one
developer-day carries the same uniqueness key, so the `onConflictDoUpdate`
added earlier that same session would have met two rows with one key in a
single insert and raised SQLSTATE 21000 on any report sharded across several
download links. Both reproduced here before being fixed.

A reviewer also corrected a claim made in a commit message on this branch.
AAD binding does **not** protect a cross-environment restore, because a
restore copies `org_id` along with the ciphertext and the context still
matches. A different `COPILOT_ENCRYPTION_KEY` per environment is what covers
that. The code comment says so now.

**Review findings carried, not fixed.** Recorded so none of them reads as
settled:

1. `users.github_username` has no uniqueness constraint and no `is_active`
   filter in the match. Two user rows with one login both receive the day's
   events, both get a snapshot, both feed budget alerts, and nothing in the
   response says so. Raised by two reviewers. Wants a partial unique index on
   `(org_id, lower(github_username))`, which is a migration.
2. The two sources disagree about what a day is. ccusage reports a
   developer's local day; the GitHub report is UTC. A US Pacific developer
   working after 16:00 local lands under D for the agent and D+1 for the org,
   where no agent copilot row exists, so the org row counts in full and the
   per-day preference is defeated across the midnight boundary. It is
   symmetric here: a UTC+5:30 developer working 00:00 to 05:30 lands under D
   for the agent and D-1 for the org.

   **Measured 2026-11-10, no longer inferred.** `ccusage daily --help` does
   carry `-z, --timezone <timezone>` (IANA), and `ccusage.ts:133` does not
   pass it, so the agent writes whatever ccusage's default bucketing calls a
   day. Running the same range twice on one real machine, default against
   `-z UTC`, rebuckets real money between adjacent days:

   ```
   date          local$    utc$      delta
   2026-11-04    62.70     128.08    +65.38
   2026-11-05    341.85    389.33    +47.48
   2026-11-06    585.00    486.06    -98.94
   2026-11-07    19.23     5.30      -13.93
   ```

   Totals reconcile, so nothing is lost, only moved. What is still unmeasured
   is a Copilot double-count end to end, which needs a Copilot Business org
   this account cannot reach. The mechanism is confirmed; the magnitude on
   copilot rows specifically is not.

   **The `date between d-1 and d+1` fix is rejected.** It converts a bounded
   overcount into an unbounded undercount: a developer who uses Copilot on a
   machine the agent is not installed on would have that org-only day erased
   by an adjacent agent row, and a disappearance surfaces as nothing. It also
   makes day `d`'s snapshot depend on `d±1` while nothing rebuilds `d` when
   `d±1` is written, which is the same family of defect as BW-41. Two bugs of
   one shape is reason enough on its own.

   The real fault is upstream. The agent knows its own timezone and ccusage
   takes `-z UTC`. Bucket both sources by UTC and the existing per-day SQL is
   correct as written. The cost is that a developer's "today" shifts by their
   offset and historical rows stay local-bucketed unless backfilled, which
   makes it a data-semantics decision for the operator rather than a patch.
   Deliberately not taken on this branch.
3. `githubStatusFrom` recovers a status by regex over an error message, so a
   transport failure (DNS, blocked egress, timeout) reads to the operator as
   "GitHub rejected this token" and invites them to rotate a working
   credential. Wants a typed error carrying the status.
4. A client whose tokens appear only under `totals_by_model` counts as zero,
   because the mapper deliberately reads the client-level sum and the fixture
   happens to carry both. A fixture cannot catch this; the fixture is the
   assumption.
5. The record's own `day` is validated and then discarded in favour of the
   requested day, so a report that ever carried records for another date
   would file them silently under the wrong one.
6. `MAX_SEAT_PAGES` returns partial data at the cap rather than throwing,
   though the comment says reaching it means the pagination contract changed.
7. `PUT /connection` and `POST /sync` are the only mutating routes in the API
   with no `config.rateLimit`, against the convention every other writing
   route follows.
8. `GET /status` reports `connected` from row existence alone, so a
   credential that no longer decrypts reads as healthy until someone syncs.

**Scope gap, and it is in the brief rather than the code.** The seat roster is
walked in full on every connect and every sync, and then everything except two
counts is discarded. The agreed scope was seat coverage, meaning which
developers hold a paid seat and which are idle, since an unused Copilot
Business seat costs $19/month whether or not anyone opens an editor. The API
fetches exactly the data that answers it, and nothing surfaces it. Half of
what this ticket set out to deliver is therefore still open.

**Verification debt this will carry.** Blocker 2 from 2026-11-06 still stands
and is now the only one. Without a Copilot Business or Enterprise plan there
is nothing to pull against, so every part of this runs on fixtures until an
operator points it at a real org.

The record schema itself is no longer the unknown; GitHub publishes it. Three
smaller things are genuinely undocumented rather than merely unfound, and the
code should be defensive about each rather than encoding a guess:

1. The signed `download_links` are stated to have "a limited expiration time"
   with no duration given, and nothing says whether to resend the
   `Authorization` header when fetching one. Fetch without it first.
2. No lag or cutoff is published for when a day's report becomes available.
   Request yesterday rather than today, and treat a 404 on a recent day as
   expected rather than as a failure.
3. `assignee` is schema-nullable on the seats endpoint, but no prose says when
   or why. Skip those records and log them; do not assume they are pending
   invites.

Also worth guarding: the customization arrays are capped at 25 named entries
per user per day with the overflow collapsed into an `other` entry, and the
docs warn that absence from a capped array does not mean zero usage.

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

**Done 2026-11-06.** All 13 pages and 5 components on `@theme` tokens.

**The first acceptance line was written too absolutely and is amended rather
than ticked as-is.** Five `style={{}}` survive, and all five carry a value
that only exists at runtime: three bar widths computed from a ratio, two
background colours read from the agent palette. Tailwind generates its classes
by scanning source at build time, so a class built from a template literal is
a class that never gets generated. Writing these as utilities would mean
either shipping a safelist of every percentage or inlining a `<style>` tag —
both larger and worse than the attribute they replace.

Checked 2026-11-06: `grep -rn 'style={{' apps/dashboard/src` returns exactly
those five, in `activity/page.tsx`, `projects/page.tsx`,
`charts/AgentBreakdown.tsx` and twice in `components/ui.tsx`.

**Acceptance**
- [x] No `style={{}}` left in `apps/dashboard/src/app` **except for values
      computed at runtime**, which Tailwind cannot express — five remain, all
      of that kind, enumerated above
- [x] Rendered output visually unchanged — browser pass at 1440px and 390px on
      every page, signed in against the real API

### BW-23 · Fix ARCHITECTURE.md drift
**Size S** · blocked by BW-08

Known drift:
- ~~Documents an `install-schedule` CLI command that does not exist~~ fixed:
  the agent table now lists `register`, `sync`, `status`, `install-cron`,
  `uninstall` and the `src/lib/cron.ts` row
- ~~Quickstart still describes the Render and local-only setup~~ fixed
- ~~Needs the Vercel Services topology from BW-04~~ BW-04 was superseded. The
  real topology is two Vercel projects from one repo, now documented

**Corrected 2026-11-06.** The doc carried the same stale Redis claim as BW-28
and BW-29 in four more places: a Redis box in the system diagram, "Results
cached in Redis (5-minute TTL)" in the data flow, a `src/plugins/redis.ts`
row for a file that no longer exists, and `REDIS_URL` in the Quickstart. All
four removed. A fifth lived in a code comment in `api/index.mjs` and was
removed with them.

Also corrected: the component table now lists `build-server.ts` separately
from `server.ts` (BW-03), `rate-limit-store.ts`, the shared `query-schema.ts`
and `enrichment.ts`, and the migrations directory. Quickstart now runs
`db:migrate` rather than `db:push`, which BW-17 stopped using against
deployed databases, and the final `sync` step carries `--days` with a note
that a bare `sync` writes yesterday.

**Acceptance**
- [x] Every documented command exists — verified: root `db:migrate`,
      `/v1/auth/admin/bootstrap`, `register --api-url`, `sync --days`
- [x] Deployment section matches the Vercel setup — both projects, both
      config files, the CLI relink step, and the real env var lists
- [x] Quickstart followed start to finish on a clean checkout — **done
      2026-11-06**, and the prediction held exactly: verifying that every
      command exists catches a wrong step and is blind to a missing one.
      Three of the eight steps failed on a fresh `git clone` against an empty
      database. The Quickstart is now twelve steps.

**What the walk found.** Each failure is a step the doc never had, not a step
it got wrong — which is why reading it carefully could never have surfaced
them.

| Step | Result |
|---|---|
| 1 · clone + `npm install` | PASS |
| 2 · configure API | PASS, but `.env.example` ships three keys nothing reads: `REDIS_URL`, `CORS_ORIGIN`, `COPILOT_ENCRYPTION_KEY` |
| 3 · `npm run db:migrate` | PASS — 5 migrations, 12 tables, and it creates `drizzle.__drizzle_migrations`, which is exactly what production never got (BW-37) |
| 4 · start API | **FAIL.** `ERR_MODULE_NOT_FOUND: @burn-watch/shared/dist/index.js`. The package has to be built first and no step said so. |
| 5 · bootstrap | PASS |
| 6 · start dashboard | **FAIL at sign-in, twice.** First a 500: the dashboard reaches Neon directly for better-auth and had no `DATABASE_URL`, so it fell through to libpq defaults (`host: localhost, user: akbarsha`). `apps/dashboard/.env.local.example` exists and the Quickstart never mentions it. Then, once configured, `relation "user" does not exist` — better-auth owns `user`, `session`, `account` and `verification`, drizzle's migrations do not contain them, and nothing told you to run better-auth's own CLI. |
| 7 · register agent | **FAIL as written.** It blocks indefinitely on BW-30's approval gate, waiting for a human to enter its code in the dashboard. The CLI says so on screen; the doc does not, so a reader scanning the steps sees a one-liner and a hang. It also overwrites `~/.burnwatch/config.json` with no prompt and no backup. |
| 8 · `sync --days 7` | PASS — 26 events across 7 days |

Also fixed while there: steps 7 and 9 each start a server and block, and the
old step 6 began `cd apps/dashboard` as though the previous `cd apps/api` had
not happened. The rewrite says which commands need their own terminal and
anchors every path at the repo root.

**One thing the walk found that is not a doc bug.** `register` clobbering an
existing `~/.burnwatch/config.json` is a real hazard — it silently repointed
this machine from production to localhost, and the production device token in
that file is not recoverable. Documented as a warning for now; the agent
should refuse or back up instead. Now BW-38.

**The walk was run twice, independently, and the second pass earned its keep.**
The two runs agree exactly on every step that failed and on the errors each
produced, which is the useful kind of corroboration — same `ERR_MODULE_NOT_FOUND`
at step 4, same pair of 500s at step 6, same block at step 7.

They diverge on three conclusions, and the first pass was wrong on all three.
It reported that better-auth's tables could not be created because no CLI
exists in the repo, that the bootstrapped admin could never have a password,
and that steps 7 and 8 were therefore unreachable "full stop". All three are
wrong, and checking cost one command each:
`npx @better-auth/cli@latest migrate` is fetched from npm rather than being a
local dependency and creates all four tables; `/signup` is exactly the path
that sets the bootstrapped admin's password, and the sign-up route gates on an
existing active `users` row for that reason; with those two done, registration
completes and `sync --days 7` accepted 26 events. **A dependency being absent
from `node_modules` is not evidence that a tool does not exist** — that was the
mistake underneath all three.

What the second pass missed and the first caught: at step 8 it ran `sync` with
no local device token, the command silently fell back to the pre-existing
global config pointed at production, and seven consecutive 500s exposed the
BW-37 outage. That finding is worth more than the three wrong conclusions cost,
and it is the reason BW-37 is now sized correctly.

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

**Done 2026-11-06**, merged in `345023d`. `projects.ts` unnests with
`jsonb_array_elements`, `activity.ts` with `jsonb_each_text`, both through
`orgEnrichment` in `routes/dashboard/enrichment.ts`. The characterization
tests written first (`81059a4`) pinned the response shape across the rewrite.

**Acceptance**
- [x] Aggregation happens in postgres, not in the route
- [x] Both routes share one helper — `orgEnrichment`
- [x] Response shape unchanged, proven by the existing route tests

### BW-26 · Remove the double type assertion in `overview.ts`
**Size S** · no blockers

`overview.ts:55-57` reads per-agent columns with
``today?.[`${agent}Tokens` as keyof typeof today] as number``. Two assertions
stacked like that turn the type checker off for the agent fan-out, which is
exactly where a renamed column would otherwise be caught.

**Done 2026-11-06**, merged in `8b92184`. The computed-key fan-out is gone;
each agent's columns are named as literals, so the checker sees the access.
Falsified by renaming a snapshot column and watching `tsc` catch it, which is
the whole point of the ticket and could not happen while the assertions stood.

**Acceptance**
- [x] No `as` on that access path — no `as keyof` or `as number` left in the file
- [x] Renaming a snapshot column produces a type error

### BW-27 · Enforce device token revocation, or drop the table
**Size M** · no blockers

`device.ts:132` hashes the access token into `device_tokens` on issue, which was
the June audit's P0-5 fix and is correct. Nothing ever reads it back. A revoked
or stolen device token stays valid for its full 30 days.

Decide before building: either check the hash on `requireAuth` and add a
revocation endpoint, or drop the table and stop implying a capability that does
not exist. Checking on every request costs a lookup per authenticated call, so
it wants Redis rather than postgres.

**Done 2026-11-06**, closed in `79df6e8`. Took the first branch: the device
auth guard looks the token row up with `device_id = <uuid> and revoked_at is
null`, so revocation is a condition of the query rather than a check after it.
Postgres, not Redis — the lookup is one indexed row per authenticated call and
Redis had already been removed from the API by BW-08.

**Acceptance**
- [x] A revoked token is rejected, with a test — `routes.test.ts`, "refuses a
      device whose token row has been revoked"
- [x] ~~Or the table and its write are removed~~ not taken; enforcement shipped

### BW-28 · Share the dashboard query schema and cache wrapper
**Size S** · no blockers

`dateRegex` and the near-identical `from`/`to`/`date` Zod object are declared
five times, once per dashboard route. ~~The Redis get, miss, compute, set,
expire sequence is written out five times too.~~

**Half this ticket was void on arrival, corrected 2026-11-06.** The cache it
describes was deleted in `57d9d0b`, merged under BW-08, one commit before this
ticket was filed. That commit's own reasoning was that Postgres is fast enough
at this scale and removing the cache removes a whole dependency. There is no
Redis import, no get/miss/compute/set/expire sequence and no `ioredis`
dependency left anywhere. Nothing to extract.

Building a `withCache` helper now would revive an architecture layer the team
deliberately removed, on no measurement. If Postgres read latency ever becomes
the complaint, that is a new ticket with a number on it, not a silent revival
inside a DRY cleanup.

`fetchOrgEnrichment` is also already handled. BW-25 landed `orgEnrichment` in
`routes/dashboard/enrichment.ts`, shared by Activity and Projects.

What is left is real: the five duplicated query schemas.

**Done 2026-11-06**, merged in `456a954`. `routes/dashboard/query-schema.ts`
exports three pieces rather than one object: `dateQuerySchema` for the three
routes that need exactly the date range, `dateQueryShape` for `leaderboard.ts`
to extend with `limit`, and `dateRangeFields` for `trends.ts` to compose with
`days`. Composition rather than one wide schema is what keeps the two routes
with extra parameters from loosening validation for the other three.

**Acceptance**
- [x] One query schema, imported by every dashboard route, with `trends.ts`'s
      `days` and `leaderboard.ts`'s `limit` still composed on rather than
      flattened away, and no validation loosened
- [x] ~~One cache helper, with the per-route key still distinct~~ void, the
      cache was deleted before the ticket was written
- [x] Route tests unchanged and passing

### BW-29 · De-duplicate the event builder in `ccusage.ts`
**Size S** · no blockers

`ccusage.ts` builds the same `UsageEvent` roughly 30 lines at a time in two
places: `parseOutput` (`:84-103`) and `collectRange` (`:169-188`). The copies
are currently identical, which is the point — they can drift, and a free-tier
or token-summing rule fixed in one would silently stay wrong in the other.

The collector tests from BW-11 cover both paths, so this is a safe extraction.

**Done 2026-11-06**, merged in `fa10270`. `buildEventsForEntry` is the single
builder; `parseOutput` and `collectRange` both call it. The BW-11 collector
tests were not touched, which is what makes them evidence here rather than a
rewrite that agrees with the new shape.

**Acceptance**
- [x] One function builds the event, called from both paths
- [x] `apps/agent` tests pass unchanged

### Confirmed present, deliberately not ticketed

**No API versioning beyond the `/v1` prefix.** ROADMAP.md lists this as
explicitly out of scope. Recorded so the next reader does not re-raise it.

**Dashboard fetches with `cache: 'no-store'`** (`lib/api.ts:23`). Real. The
note here used to say the API answered from a 300-second Redis cache, so the
repeated load landed on Redis rather than postgres. That stopped being true in
`57d9d0b`, which dropped Redis entirely. Every dashboard read now goes to
postgres on every request, by choice. Revisit only if postgres shows it.

### BW-30 · `verify-device` has no approval gate
**Size M** · P0 · found 2026-11-05 during the BW-08 smoke test

`POST /v1/auth/verify-device` requires `pendingId` and `code` — and
`POST /v1/auth/register-device` returns **both of them in its own response**.
Nothing checks that a human approved anything. Two unauthenticated calls, the
second using data the first handed back, produce a 30-day access token and a
90-day refresh token for any email already in `users`.

Demonstrated against production during the smoke test. No browser, no dashboard
session, no admin involvement:

```
POST /v1/auth/register-device {"email":"dev1@test.com",...}
  -> 200 {"pendingId":"98b214e4-...","code":"BXZJGU"}
POST /v1/auth/verify-device   {"pendingId":"98b214e4-...","code":"BXZJGU"}
  -> 200 {"accessToken":"eyJ...","refreshToken":"eyJ...","deviceId":"16db583a-..."}
```

This is the hole the 2026-06-23 pending-device work was written to close. The
agent prints "Enter this code in the BurnWatch dashboard to verify your device"
and then polls — but the first poll three seconds later succeeds unconditionally,
so the dashboard step is decorative. `pending_devices` is referenced only in
`routes/auth/device.ts`; no dashboard route reads or approves it, and the
dashboard has no pending-device UI.

What stands between this and an attacker is one rate limit, `max: 5 / 15 min` on
`register-device` — which BW-05's revert made per-instance, so it is really
`5 × live instances`. A valid work email is the only secret involved, and work
emails are not secrets.

**Fix needs three parts, which is why this is not a quick patch:**
1. `pending_devices` grows an `approved_at` (and ideally `approved_by`) column.
2. A dashboard-authenticated `POST /v1/auth/approve-device` sets it;
   `verify-device` additionally requires `approved_at is not null`.
3. Dashboard UI to enter the code — the screen the agent already tells people to
   use, which has never existed.

Until then the deployment is only safe because `burn-watch-api.vercel.app` is
unadvertised, which is not a security control.

**Done 2026-11-05.** `pending_devices.approved_at` (migration
`0001_add_pending_device_approval.sql`, a nullable column, so every row that
existed before the fix is now permanently unverifiable — which is the intent).
`POST /v1/auth/approve-device` sits behind `requireDashboardAuth`, so a device
token gets 403 and only a browser login can reach it. It claims the row in one
`UPDATE ... RETURNING` matched on the code and the signed-in user's own email,
read from `users` by the token's `userId` rather than from the request:
approval is only ever possible for your own device, and two clicks on one code
cannot both win. Unknown, expired, already-approved and someone-else's codes all
answer `400 Invalid or expired verification code`, so the endpoint cannot be
used to probe for live codes. `verify-device` gained
`isNotNull(pendingDevices.approvedAt)`. The dashboard screen is `/devices`,
reachable by every signed-in role, not just admins — the person approving is the
developer whose terminal printed the code.

No `approved_by`. The email match already pins approval to one user, and nothing
reads an audit trail yet; add the column when something does.

Two consequences worth naming. The agent's poll was the one caller that never
exercised `verify-device`'s rate limit, because the first poll always succeeded;
with a real wait in front of it the loop would have hit `max: 10 / 15 min` and
registration would have failed outright. Poll interval is now 10s and the cap is
600 per 15 minutes — high on purpose, since reaching the route at all needs the
`pendingId`, a v4 UUID handed only to the caller that registered, and
`@fastify/rate-limit` keys on IP, which a whole office shares behind one NAT.
And **the migration must run before the API deploys**: the new code selects on a
column that older databases do not have.

**Acceptance**
- [x] `verify-device` returns 400 for a pending device nobody approved
- [x] Approval requires a dashboard session, not a device token
- [x] A test asserts the two-call self-service sequence above now fails
- [x] The agent's polling loop reflects a step that actually gates

### BW-31 · Agent default `--api-url` pointed at a domain that never existed
**Size S** · done 2026-11-05

`index.ts` and `register.ts` both defaulted to `https://api.burnwatch.com`. That
domain has never been registered, so `burnwatch register` without an explicit
`--api-url` could only ever fail on DNS. Replaced with a single exported
`DEFAULT_API_URL` in `lib/config.ts`, now pointing at the deployed API, so the
two call sites cannot drift apart again.

**Acceptance**
- [x] One constant, imported by both call sites
- [x] Points at the live API

### BW-32 · launchd plist named the runtime, not the burnwatch binary
**Size S** · done 2026-11-05

`register.ts` passed `process.execPath` to `installCron()`. That is the binary
only in a `bun build --compile` build. Run from source it is the bun runtime, so
the plist written on 2026-11-05 said:

```
/Users/akbarsha/.bun/bin/bun
sync
```

`bun sync` exits with `error: Script not found "sync"`. The job fired at 6 PM
every day, failed, and wrote to a log nobody reads. Nothing caught it: the
install is skipped when a plist already exists, so tests never reached it, and
the line reads as correct. It was only visible by running register for real and
then reading what it left on the machine.

The obvious fix is to detect which mode is running and fall back to
`process.argv[1]`. Both candidate signals lie. `process.execPath` is ambiguous
by definition here, and `process.argv[1]` holds a real path from source but a
virtual `/$bunfs/root/burnwatch` path when compiled — and `existsSync` returns
`true` for that virtual path, because Bun shims `fs` over the embedded bundle. A
disk-presence guard would have shipped a silent coin flip. The only remaining
attribute was a string prefix on `/$bunfs/`, which is undocumented and differs
on Windows.

So the resolution does not read an attribute, it runs the candidate.
`resolveSelfCommand()` tries `[execPath]`, then `[execPath, argv[1]]`, invoking
each with a hidden `__self-check` command and requiring the sentinel
`burnwatch:self-check:ok` on stdout. Only burnwatch prints it, so the runtime
alone fails and the first shape that answers is the one scheduled. Compiled
builds still resolve to `[binary]`, unchanged. `installCron()` now takes no
argument and returns the argv it scheduled, or `null`, which removes the
parameter that made the wrong path passable in the first place.

Two things came along with it, both in the same function. The plist template
interpolated paths straight into XML, so a home directory containing `&` would
have produced an unparseable plist; arguments are escaped now. And
`launchctl load ${PLIST_PATH}` ran through a shell, which breaks on a home
directory with a space; both launchctl calls use `execFileSync` with an argument
array.

New command: `burnwatch install-cron`. Fixing the writer does not fix what was
already written, and the install is guarded by `isCronInstalled()`, so upgrading
the binary would never repoint an existing plist. Anyone carrying a broken one
runs `burnwatch install-cron` to tear it down and rewrite it. It is also how the
fix was verified without driving a whole registration.

Verified on both surfaces. From source the plist now holds
`[bun, /abs/path/apps/agent/src/index.ts, sync]` and that command runs. From
`dist/burnwatch` it holds `[dist/burnwatch, sync]` and that runs too. The test
asserting the runtime is rejected was mutation-checked against the old
`execPath`-only behaviour and fails on it.

**Acceptance**
- [x] A source-mode install writes a plist whose command actually runs
- [x] A compiled-mode install still writes `[binary, sync]`
- [x] `installCron()` cannot be handed the wrong path
- [x] A test fails if the resolver accepts the bare runtime
- [x] Existing broken plists have a repair path

### BW-33 · Copilot usage silently dropped by the ccusage collector
**Size S** · done 2026-11-05

`AGENT_MAP` in `apps/agent/src/collectors/ccusage.ts` listed claude, qwen,
gemini and codex. It did not list copilot, even though `AgentName`
(`packages/shared/src/types.ts:30`) and the `usage_events.agent` column comment
both name copilot as a supported agent. An unmapped name resolves to `null` and
`parseOutput` skips the entry, so every Copilot day was discarded without a
warning. On this machine that is 14 days, $32.12 and 36.0M tokens.

The investigation started from a different suspicion: that ccusage emits
`agent: 'all'` rows whose `metadata.agents` holds several agents, making the
`agents?.length === 1` guard fall through to the model-name heuristic and
collapse everything onto one agent. That is not what happens. Across all 61 days
of local history, `metadata.agents` always holds exactly one entry, so the
heuristic never runs. The real shape is uniform: `agent` is always the literal
`all` and `metadata.agents` names the one agent that produced the day.

Worth keeping in mind for anyone tempted to loosen that guard. Copilot reports
Claude model names — a real Copilot day reads `claude-sonnet-4.5` — so a
fall-through to the model-name heuristic would not have dropped those rows, it
would have billed Copilot's spend to Claude. Dropping the data was the less
damaging of the two failures. The fix is the missing map entry, not a looser
branch.

Nothing caught it because the test fixture set no `metadata` at all and gave
each row its own `agent` label, a shape the real CLI does not produce. The
fixture now carries one entry in the production shape.

**Acceptance**
- [x] Copilot rows resolve to the copilot agent
- [x] A test fails if Copilot rows are dropped or billed to Claude
- [x] The fixture exercises the `agent: 'all'` plus `metadata.agents` shape

**Not done**: the 14 Copilot days already in local history are still absent from
prod. A full-history backfill with the rebuilt binary picks them up.

### Carried over, still unowned

`apps/api/.env.example` still sets `CORS_ORIGIN` (removed everywhere else by
BW-07) and `REDIS_URL` (dead since BW-08). Both lines need deleting by hand —
`.env*` is covered by a Read deny rule in the agent's permission settings, so no
session can write that file.

---

## Tickets opened 2026-11-06

### BW-34 · Agent never collects project or activity breakdown
**Size M** · P2 · todo

`apps/agent/src/collectors/codeburn.ts:110-112` hardcodes three enrichment
fields to empty, alongside two scalars hardcoded to zero:

```ts
cacheHitRate: 0,
writtenTokens: 0,
activityBreakdown: [],
projectBreakdown: [],
topSessions: [],
```

Everything downstream is built and working. `usage.service.ts:62-63` upserts the
columns, `claude_enrichment` has them, `projects.ts` merges `projectBreakdown`,
and the Projects page renders a full table off it. The chain is complete except
at the source, so the page shows "No project data" and always will.

Confirmed against production Neon on 2026-11-06. Of 33 `claude_enrichment`
rows, 31 carry `tool_usage`, and **0** carry `project_breakdown` or
`activity_breakdown`. The collector already walks every JSONL transcript and
buckets tool, shell and MCP counts per day, so the parse loop that would fill
these arrays is largely there; what is missing is the per-project and
per-activity grouping on top of it.

`OrgActivitySummary` (`packages/shared/src/types.ts:208-214`) is declared and
referenced nowhere, which fits: it is the read side of a column nothing writes.

Blocks BW-25 and BW-35, both of which operate on data this ticket produces.

**Done 2026-11-06, scoped down.** `projectBreakdown`, `cacheHitRate` and
`writtenTokens` are now filled from the transcripts. `activityBreakdown` and
`topSessions` are still empty on purpose: nothing in the API or the dashboard
selects either column, and `OrgActivitySummary` is declared and referenced
nowhere, so there is no reader to satisfy and no ground truth in a transcript
for what counts as "Debugging" rather than "Coding". Fill them when a page
asks.

Per-project cost is the day's ccusage Claude spend split by that project's
share of the day's tokens. The transcripts carry token counts and no prices,
and the standing rule is that ccusage is the only source of a cost figure, so
nothing is priced independently here. The parts sum back to the ccusage total
exactly; verified against 2026-11-05 on a real machine.

Two things the real data forced that the ticket did not anticipate:
- Turns group on the enclosing git checkout, not the recorded `cwd`. One repo
  worked from its root and from `apps/api` and `apps/dashboard` arrived as
  three projects; 21 rows collapsed to 4.
- `sessionCount` counted assistant turns containing a tool call, which is a
  turn count. It now counts distinct session ids, so the number on the
  Leaderboard will drop sharply once agents re-sync.

### BW-35 · Projects "Users" column counts rows, not users
**Size S** · P3 · todo · blocked by BW-34

`apps/api/src/routes/dashboard/projects.ts` increments `userCount` once per
contributing `claude_enrichment` row. There is one row per user per day
(`claude_enrichment_unique_user_date`), so the figure is a count of user-days
that touched the project, not a count of people. One developer on one project
for 63 days reports 63.

The dashboard renders it under a column headed "Users"
(`apps/dashboard/src/app/(dashboard)/projects/page.tsx`), so the name promises
what the number is not.

Latent today only because BW-34 leaves `project_breakdown` empty, so the table
never renders a row. It becomes wrong the moment BW-34 lands. Fix is to count
distinct `userId`, which means carrying `userId` through the merge.

**Done 2026-11-06.** The query selects `user_id` and the merge collects it
into a set. The characterization test that pinned the old row-counting
behaviour was flipped to the fixed behaviour, with two cases added: two people
on one project count as two, and one person on two projects counts once on
each.

### BW-36 · Sidebar shows the Admin link to every role
**Size S** · P5 · todo

`apps/dashboard/src/components/SidebarNav.tsx` lists `/admin` unconditionally.
A developer sees the link and `/admin` redirects them back to `/`, so this is
a dead link rather than an access hole: the page guard holds. Found on the
first screen a freshly invited developer sees, while verifying BW-19.

Fix is to pass the role into `SidebarNav` and filter the item, in both the
sidebar and the horizontal mobile nav in `(dashboard)/layout.tsx`.

### Note on BW-25

Re-aimed 2026-11-06 after measuring the data, then unblocked the same day.
The Projects half would have moved a merge into SQL that reduced over `[]` on
every row; BW-34 has since landed, so `project_breakdown` will carry real
rows as soon as agents re-sync and both halves are worth moving. The Activity
half (`tool_usage`, `shell_usage`, `mcp_usage`) already had real data, at 31
rows.

Neither merge has any test covering its correctness. `routes.test.ts` reaches
these two routes only through the shared auth, org-scoping and query-validation
blocks. Characterization tests against current behaviour are a prerequisite for
any rewrite, not an optional extra.

Separately, neither route paginates or truncates, and neither does the page.
The live Activity page renders 357 shell commands in one list.

---

## Tickets opened 2026-11-06 from the BW-18 browser verification

### BW-36 (verified) and BW-18 (three defects) — see those sections above

### BW-37 · The database has never been migrated, and nothing notices
**Size M** · no blockers · **P0**

BW-17 generated a baseline migration and four since, and switched the
documented deploy onto `drizzle-kit migrate`. The live database never followed.
It has **no `drizzle.__drizzle_migrations` table at all**, which means no
migration in `apps/api/drizzle/migrations/` has ever been applied to it. The
schema it does have was put there by `drizzle-kit push`, by hand, whenever
someone remembered.

That held until a migration was written and nobody remembered. BW-18's
`tripped_at` column exists in `schema.ts`, exists in
`0004_budget_alert_tripped_at.sql`, and did not exist in the database.

**This was not a dead feature. It was a production outage, and it took usage
ingestion down with it.** Found first as a failing budget-alert create, which
is how it is described below and under BW-18 — that framing understated it by
a wide margin. The real blast radius:

`POST /v1/usage/submit` wraps its writes in one transaction (BW-15) and calls
`evaluateBudgetAlerts` inside it. That function opens with
`select ... from budget_alerts`, and the generated select names every column
including `tripped_at` — whether or not a single alert row exists. So the
select threw, the transaction rolled back, and **every usage submission from
every agent failed with
`column "tripped_at" does not exist`**. No org had configured a budget alert;
it made no difference.

**Outage window: 2026-11-05 16:30 UTC to 2026-11-06 15:00 UTC**, roughly
22 hours. `usage_events` holds 151 rows and its newest `submitted_at` is
2026-11-05T16:30:36Z — the last submission before the BW-18 deploy. Nothing
was written after it and nothing was corrupted, because the transaction did
its job and rolled every attempt back.

Credit where due: this half was found by a second pass walking the Quickstart,
whose `sync` step fired at production and collected seven consecutive 500s.
The browser verification that found the column had no way to see it — the
panel only ever failed one create, which reads like a broken feature, not a
stopped pipeline.

The failure mode is what makes this a P0 rather than a chore. Every test
passes, every typecheck passes, and the API answers `/health` with `{"ok":true}`
— because the only thing that knows the column is missing is postgres, and
nothing asks postgres until a user does.

**Two things to fix, and they are different sizes:**

1. **The immediate gap.** `budget_alerts` needs `tripped_at` in production.
   `ALTER TABLE "budget_alerts" ADD COLUMN "tripped_at" timestamp` — additive,
   nullable, no backfill, exactly what `0004` says. Needs an operator to run
   it against the production branch.
2. **The reason it happened.** Adopt the migration bookkeeping that BW-17
   assumed. Either run `db:migrate` against production with a baseline
   `--custom` entry so drizzle stops trying to re-apply `0000` to a live
   schema, or add a migration step to the deploy so the gap cannot reopen.
   Until one of those exists, the next generated migration will sit unapplied
   exactly like this one did, and will be found the same way.

**Both done 2026-11-06.** Rehearsed on a branch copied from production before
production was touched, which is how the sequencing question got settled:

**"Just add a migrate step to the deploy" does not work, and the rehearsal
proved it rather than arguing it.** `drizzle-kit migrate` against the
un-baselined copy died with `relation "budget_alerts" already exists` — with
no bookkeeping table, drizzle starts from `0000_baseline` and tries to create
tables that have existed for months. The baseline is a hard prerequisite for
any automation, not an alternative to it.

Worth knowing for anyone who runs that command and panics: the failed attempt
is safe. Drizzle applies migrations inside a transaction, so the DDL rolled
back and the public schema was untouched at 16 tables. It does create the
`drizzle` schema and an empty `__drizzle_migrations` outside that transaction,
which is harmless and is in fact the table you are about to fill.

**The baseline.** `drizzle.__drizzle_migrations` is `(id serial, hash text,
created_at bigint)`, and drizzle's own `readMigrationFiles` defines the two
values: `hash` is sha256 over the raw `.sql` file and `created_at` is that
entry's `when` from the journal. Only `created_at` decides anything — the
migrator compares each migration's `folderMillis` against the single newest
recorded row — but all five rows carry real hashes so the table describes what
actually ran. `apps/api/drizzle/baseline-rows.cjs` computes them.

Applied to the rehearsal branch, then to production. `drizzle-kit migrate` is
now a clean no-op against production instead of a crash, and production still
reports 16 tables, 151 `usage_events`, 4 users and 4 devices — the baseline
touched bookkeeping only.

**Detection, so this cannot recur silently.** The gap this ticket is really
about is not that a migration went unapplied; it is that nothing noticed for
22 hours. `/health` now checks the newest recorded migration against the
newest the deployed code expects, and answers 503 naming `schema` when the
database is behind. A monitor sees it on the first poll after a bad deploy.

A deploy-time `db:migrate` step was considered and **not** taken. Vercel builds
previews and production from the same repo, so a build-time migration would let
a preview deploy migrate the production database, and concurrent builds would
race inside drizzle's transaction. Detection carries none of that and catches
the same failure one poll later. If it is ever automated, it belongs in a
release step that runs once, not in a build that runs per deployment.

**Diffed 2026-11-06, and `tripped_at` is the only one.** Every column drizzle's
`meta/0004_snapshot.json` declares was compared against `information_schema` on
a branch copied from production: 113 columns each way, no column in the schema
missing from the database and none in the database the schema does not declare,
once `tripped_at` is set aside. better-auth's own four tables (`account`,
`session`, `user`, `verification`) are excluded — better-auth owns them, not
`schema.ts`.

What that comparison does **not** cover: column types, nullability, defaults,
foreign keys and indexes. A column renamed in place would show up here; a
column that quietly became nullable would not. It is enough to say no second
feature is dead for the same reason, and not enough to call the schemas equal.

**Column applied to production 2026-11-06**, with the operator's go-ahead:
`ALTER TABLE "budget_alerts" ADD COLUMN IF NOT EXISTS "tripped_at" timestamp`
against the default branch. Confirmed present afterwards as
`timestamp without time zone`, nullable — which matches both `schema.ts` and
what `0004` would have produced.

**Two things that are still true after it.** The create path itself was proven
on a branch copied from production, not on production, because minting an
admin JWT needs `JWT_SECRET` from inside the deployed dashboard. And the
deployed API predates the evaluate-on-write fix, so until it is redeployed a
production alert will save without tripping — the 500 is gone, the stale
status is not.

**Acceptance**
- [x] `tripped_at` exists in production — applied and verified 2026-11-06.
      Creating an alert *there* is still unproven; see above.
- [x] Live schema diffed against `schema.ts`, with any other drift listed here
      — names only, 113 = 113, no other drift; see the caveat above
- [x] A migration bookkeeping decision applied and recorded, so an unapplied
      migration is detectable without a user finding it — production is
      baselined and `/health` answers 503 naming `schema` when the database
      runs behind the code. Decision and the rejected alternative recorded
      above.

### BW-38 · `register` overwrites an existing agent config with no prompt and no backup
**Size S** · no blockers

Found 2026-11-06 while walking the Quickstart. `register` writes
`~/.burnwatch/config.json` unconditionally. If the machine is already
registered against another BurnWatch, that file is replaced in place: a
registration against a local dev API silently repointed a laptop that had been
reporting to production, and the production `accessToken` and `refreshToken`
in the old file were the only copies. They are not recoverable. The device row
survives server-side, so the fix for a victim is to register again and have an
admin approve it — but nothing warns, and nothing hints that it happened.

The whole cost of the failure is that the overwrite is silent. Registering a
second time is a reasonable thing to want; losing the previous identity
without being told is not.

**The same root cause has a second face, and it is the more dangerous one.**
`sync` takes no `--api-url`. It reads whatever `~/.burnwatch/config.json`
happens to hold, so it targets whichever BurnWatch that file was last pointed
at — not the one you just set up. During the Quickstart walk, a `sync` run
immediately after a local `register --api-url http://localhost:3001` fired
seven submissions at **production** instead, because the local registration had
not completed and the stale production config was still in place. Nothing was
written, but only because production happened to be returning 500 at the time
(BW-37). On a healthy production it would have pushed a walkthrough's data into
the real database under a real account, from a machine the operator believed
was pointed at localhost.

One global config file with no per-invocation override is the shared cause:
`register` destroys it without warning, and `sync` trusts it without saying
which host it resolved to. Fixing one and not the other leaves the hazard.

Smallest fix that removes the harm: if `config.json` exists and its `apiUrl`
differs from the one being registered against, copy it to
`config.json.bak-<timestamp>` before writing, and say so on stdout. A prompt
is an option but the agent already prompts for email, and a backup needs no
answer. Do not add a `--force` flag for a problem a backup solves.

**Done 2026-11-06.** `backupConfig()` in `lib/config.ts` copies the file aside
and returns the path; `register` calls it immediately before `saveConfig` and
prints where it went. The backup is chmod 0600 explicitly rather than
inheriting the umask, because it holds live tokens. Timestamps use `-` rather
than `:` so the filename is legal on Windows, where the agent runs since BW-20.

`register` also reads the stored host *before* it writes anything, so when it
is about to repoint a machine it can say which BurnWatch that machine used to
report to — both up front, before the approval wait, and again in the
replacement notice.

`sync` now prints `Target: <host>` as its first line, always, and takes
`--api-url` to override the stored config for one run. The hazard was never
that the default was wrong; it was that the host was invisible. Driven through
the real CLI, not just the suite:

```
[burnwatch] Target: http://127.0.0.1:9
  Overriding the registered host for this run (http://localhost:3001)
```

That first line is exactly what would have made the Quickstart walk's
accidental production submission obvious before it was sent.

**Acceptance**
- [x] An existing config is preserved somewhere before a new one replaces it
- [x] The agent prints where it went
- [x] Registering on a machine with no existing config is unchanged, with a
      test covering both paths — `backupConfig` returns null and writes
      nothing when there is no config; 9 tests in `lib/config.test.ts`, and
      deleting the copy turns three of them red
- [x] `sync` prints the host it resolved before it submits anything, so a run
      against the wrong BurnWatch is visible in the first line of output
- [x] `sync` accepts `--api-url` to override the stored config for one run

---

### BW-39 · Setup instructions are macOS-only, and Windows could never collect
**Size M** · follows BW-20

BW-20 taught the agent to schedule itself on three platforms — launchd on
macOS, a systemd user timer on Linux, a Task Scheduler task on Windows. The
instructions never caught up. `/setup` and `docs/INSTALL.md` both told every
developer to run `curl | bash`, `sudo mv` the binary into `/usr/local/bin`,
and then, on Linux, to hand-write a crontab line:

```
(crontab -l 2>/dev/null; echo "0 18 * * * /usr/local/bin/burnwatch sync") | crontab -
```

That line was wrong from the day BW-20 landed. `register` already installs a
systemd timer on Linux, so anyone who followed the page ended up with two
schedules firing the same sync. Windows was not mentioned at all, in either
document, despite `build:windows-x64` shipping on 2026-11-06.

**The worse half was not documentation.** `CcusageCollector` spawns `npx`
through `child_process.spawn` with no shell. On Windows `npx` is `npx.cmd`,
which a bare spawn will not resolve: it fails `ENOENT`, `runCcusage` logs a
spawn error and returns null, and `collect` returns an empty array. No throw,
no non-zero exit. A Windows developer would have registered, watched the
schedule install, and reported zero usage every evening for ever, with the
only trace a line in a log nobody reads. Writing Windows install instructions
on top of that would have been shipping a lie.

**Done 2026-11-10.**

`spawn` now takes `shell: process.platform === 'win32'`. Nothing else changes
on macOS or Linux. The arguments are fixed strings plus a `YYYYMMDD` date, so
there is nothing for a shell to mangle. Two tests in `ccusage.test.ts` fake
`process.platform` and assert the option both ways; deleting the line turns
both red.

`/setup` is now one client component, `components/SetupSteps.tsx`, behind a
three-way OS switch that defaults to whatever `navigator.userAgent` reports.
A switch per step would have meant a reader flipping it four times, so the
whole body moved client-side rather than the alternative of three copies of
the page. `lib/os.ts` holds the detection as a pure function with five tests,
including the one that matters — Android reports Linux, and nobody installs
the agent on a phone.

Four steps now differ by OS: installing Bun, building and placing the binary,
the config path, and verifying the schedule. Windows gets the PowerShell
build, the `$HOME\bin` PATH line nothing else sets, and `schtasks /query /tn
BurnWatchSync`. Linux gets `loginctl enable-linger`, which the systemd backend
has needed since BW-20 and never said so anywhere a user would look. The
troubleshooting table branches the same way, including a
`burnwatch: command not found` row that did not exist before and is the first
thing a Windows developer will hit.

`docs/INSTALL.md` carries the same content, plus a table of the four
cross-compile scripts so one machine can produce every binary and a developer
without Bun can skip straight to `register`. `setup.md` and
`docs/ARCHITECTURE.md` had their own macOS-only scheduling lines; both now
name all three backends.

Both documents said plainly that nobody had watched Linux or Windows
scheduling fire on real hardware. Settled 2026-11-10 against v0.2.1 on
GitHub-hosted Linux and Windows runners; see the verification debt table at
the top.

**Acceptance**
- [x] Windows collects instead of silently reporting zero — `shell: true` on
      win32, falsified both ways
- [x] `/setup` serves macOS, Linux and Windows commands, defaulting to the
      reader's own OS
- [x] The wrong Linux crontab instruction is gone from both documents
- [x] Windows appears in the install docs at all, including PATH and the
      prebuilt-binary route for a machine without Bun
- [x] `loginctl enable-linger` is documented where a Linux user will find it
- [x] Browser pass at 1440px and 390px, all three tabs

---

### BW-40 · Every developer has to install Bun and build from source
**Size M** · follows BW-39

BW-39 made the setup instructions correct on three platforms. It did not make
them short. Every developer was still asked to install Bun, clone the
monorepo, run `npm install`, build a binary and move it onto their PATH —
five steps and three of them can fail, times 50-plus people. The repo already
cross-compiled all four targets; nothing published them, so the only way to
get a binary was to make one.

A `scripts/install.sh` already existed and had never run. It resolved the
latest tag through the GitHub API and then downloaded an asset from a release
that did not exist, so its real behaviour was
`No releases found. Ask your admin to create a release first.` It also did no
integrity check at all, and defaulted to `/usr/local/bin` with a `sudo`
fallback — a password prompt in the middle of a piped-to-shell install.

**Done 2026-11-10.**

Release `v0.2.0` publishes four binaries and a `checksums.txt`. A `v0.1.0`
from 2026-06-24 was already there — three binaries, no checksums, built before
BW-31 fixed the default API URL, so `register` on it dies with a DNS error. Its
`darwin-x64` asset has two downloads, so it was not overwritten; a new tag was
cut instead. The agent version is now one constant in `src/version.ts`, tested
against `package.json`, rather than three literals that had already drifted
into the `devices` table. The asset
names are the contract: `scripts/install.sh` maps `uname -s`/`uname -m`
straight onto them, so renaming one silently breaks every install command in
the docs and on `/setup`. `docs/INSTALL.md` says so next to the release
recipe.

The installer was rewritten rather than extended:

- **It verifies.** `checksums.txt` is downloaded alongside the binary and
  compared with `shasum` or `sha256sum`, whichever the machine has. No
  checksum entry, no matching hash, or neither tool present — it refuses and
  installs nothing. Piping a 100 MB binary from the internet into a shell
  without checking it was the worst thing about the old script.
- **It needs no sudo.** Default is `~/.local/bin`, overridable with
  `BURNWATCH_INSTALL_DIR`. A `sudo` prompt inside `curl | sh` trains people to
  type their password into a pipe.
- **It skips the API.** `releases/latest/download/` resolves server-side, so
  there is no unauthenticated `api.github.com` call to be rate-limited at 60
  an hour during a fleet rollout. `BURNWATCH_VERSION` pins a tag.
- **It warns about the copy it cannot replace.** Anyone who installed by hand
  before releases existed has a binary in `/usr/local/bin` that wins the PATH
  lookup. The script compares `command -v burnwatch` against where it just
  wrote and says so, rather than reporting a successful upgrade that changes
  nothing.
- **It shows progress.** The binary is 61–115 MB depending on target, because
  `bun build --compile` embeds the runtime. A silent `curl -s` reads as a hang.

`scripts/install.ps1` is the Windows half, since `curl | sh` is not a thing
there and leaving Windows on build-from-source would have undone BW-39. Same
checksum gate via `Get-FileHash`, same install directory, and it appends to
the user PATH because nothing else will.

`/setup` drops from six steps to five: install, register, backfill, confirm,
schedule. Build-from-source moves into a native `<details>` — still there for
anyone who wants it, no longer page height everyone else scrolls past.

**Verified 2026-11-10.** `install.ps1` ran on `windows-latest` against v0.2.1:
downloaded `burnwatch-windows-x64.exe`, matched the checksum, installed to
`C:\Users\runneradmin\.local\bin\burnwatch.exe`, appended to the user PATH,
and `burnwatch --version` printed `0.2.1`. It had been reviewed and never
executed; executing it is also what exposed the two v0.2.0 release defects
recorded in the verification debt section.

**Acceptance**
- [x] Four binaries and `checksums.txt` published as a GitHub release
- [x] One command installs on macOS and Linux, verified end to end on this
      machine — fresh install, checksum pass, `--version` answers
- [x] The installer refuses on a checksum mismatch instead of installing
- [x] No sudo, and no `api.github.com` dependency
- [x] `/setup` and `docs/INSTALL.md` lead with the one-liner, build-from-source
      demoted to a disclosure
- [x] Release recipe documented for admins, including that asset names are the
      contract
- [x] `install.ps1` run on a real Windows machine — `windows-latest`,
      v0.2.1, 2026-11-10

---

### BW-41 · Concurrent rebuilds overwrite a daily snapshot with stale totals
**Size S** · no blockers · found by the BW-21 adversarial review

`rebuildDailySnapshot` reads and then writes in two statements: an aggregate
`SELECT` over `usage_events`, then an upsert into `daily_snapshots`. Nothing
locks the `(user_id, date)` being rebuilt, and nothing raises the isolation
level above READ COMMITTED.

Two transactions that overlap therefore both read before either commits, and
the second overwrites the first with figures computed from a view that did
not include it:

```
T1  BEGIN; insert usage_events row
T2  BEGIN; insert usage_events row
T1  aggregate SELECT   -> cannot see T2's uncommitted row
T2  aggregate SELECT   -> cannot see T1's uncommitted row
T1  upsert daily_snapshots; COMMIT
T2  upsert daily_snapshots  (waits on T1's row lock, then applies
    values it computed before T1 committed); COMMIT
```

The row lock does not save it. Postgres serialises the write, not the
arithmetic that preceded it.

**This predates BW-21.** `git show main:apps/api/src/services/snapshot.service.ts`
has the same read-then-write shape, so two devices belonging to one developer
submitting on the same date already race it, and the snapshot ends up missing
one device's rows. Recorded against its own ticket rather than BW-21 for that
reason.

BW-21 widens it rather than causing it. The org sync is a second kind of
writer on the same `(user_id, date)`, both default to yesterday, and the
failure gains a new mode: instead of merely losing rows, the wrong *source*
can win, so a developer whose machine reported real Copilot usage can end up
with the credit-derived approximation stored against them. Self-healing only
if something rebuilds that date again, which nothing routinely does, because
tomorrow's sync targets tomorrow.

The same gap explains a second claim in `snapshot.service.ts` that does not
hold: deleting a `usage_events` row changes what the aggregate would return
but triggers no rebuild, so the snapshot keeps the old total.

**Suggested fix**, one line, covering both callers at once. As the first
statement of `rebuildDailySnapshot`:

```sql
select pg_advisory_xact_lock(hashtext($1 || $2))
```

keyed on user and date, released at transaction end. `SELECT ... FOR UPDATE`
on the snapshot row was considered and rejected: it locks nothing when the
row does not yet exist, which is exactly the first-write-of-the-day case.
Folding the aggregate into the upsert as one `INSERT ... SELECT` is correct
too and is the better long-term shape, but it is a rewrite rather than a
guard.

**Fixed 2026-11-10**, commits `775854b` (repro), `52ff9e8` (fix), `b8d2285`
(comment correction). The suggested one-line guard is what shipped.

The repro lives at `apps/api/src/scripts/bw41-snapshot-race.ts` and is run by
hand against a branch, not by `npm test`. The suite's fake Drizzle resolves
every query inline, so two overlapping reads have nowhere to overlap. A
barrier holds both writers at the point their snapshots diverge, because two
transactions racing one row otherwise serialise by luck and the script passes
against unfixed code.

Against Neon Postgres 18, before and after:

```
daily_snapshots.total_tokens: 1000   (usage_events hold 2000)
daily_snapshots.total_tokens: 2000   PASS
```

Two things learned that are not visible in the diff. The guard works only
under READ COMMITTED, since the waiter takes a fresh snapshot per statement;
raising the isolation level would break it silently. And it has to be the
`_xact_` variant, because production connects through Neon's pooler in
pgbouncer transaction mode, where a session-scoped advisory lock leaks across
clients. The live repro passes either way, so a suite test covers that one.

Adding a statement to the rebuild shifted the positional result queue the
route tests use to fake Postgres. One test went red; two more kept passing
because the rebuild then returned early before the assertion's subject ran.
All three were found by grepping the `// rebuild:` sequence comments rather
than by trusting the runner. Deleting the new slot again makes the rollback
test answer 200 instead of 500, which is the check that it is load-bearing.

**Acceptance**
- [x] Two concurrent rebuilds of one `(user_id, date)` leave a snapshot that
      matches a fresh aggregate over `usage_events`
- [x] Proven against a real Postgres with two overlapping transactions, not
      asserted from the rendered SQL
- [x] The order-independence claim in `snapshot.service.ts` either holds or
      is corrected to say what it actually covers. It was corrected. The
      preference does not follow deletes, and the comment now says so

---

### BW-42 · `npm ci` installs the agent from a stale lockfile entry
**Size XS** · no blockers · found independently by two delegates on 2026-11-10

`apps/agent/package.json` says `0.2.1`. The `apps/agent` entry in the root
`package-lock.json` says `0.1.0`. Verified by reading both:

```
package.json version: 0.2.1
lockfile entry:       0.1.0
```

`npm install` corrects it, which is why nobody has noticed. `npm ci` does not,
because `ci` installs the lockfile as written and treats it as authoritative.
Anywhere that runs `ci` rather than `install`, which is the normal choice for
CI and for a reproducible build, resolves the agent at the older version.

It surfaced twice in one session because two agents in separate worktrees each
ran `npm install` and each got an unrelated lockfile change in their diff. Both
reverted it by hand to keep their change clean. That is the real daily cost: a
spurious hunk that every contributor has to notice and discard, and that will
eventually be committed by someone who does not.

**Suggested fix.** Run `npm install` at the root and commit the resulting
`package-lock.json` on its own, touching nothing else. Confirm with a clean
`npm ci` that the installed agent version matches `package.json`.

**Acceptance**
- [ ] `package-lock.json` agrees with `apps/agent/package.json`
- [ ] A fresh `npm ci` installs the agent at the version `package.json` names
- [ ] `npm install` on a clean tree leaves `package-lock.json` unmodified
