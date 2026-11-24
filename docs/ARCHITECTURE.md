# BurnWatch Architecture

## What is BurnWatch?

BurnWatch is an AI token usage dashboard for engineering organizations. It tracks per-developer spend across multiple AI agents (Claude, Qwen, Gemini, Codex, Copilot) and surfaces cost visibility for management.

Target: companies with 50+ developers using AI coding assistants.

## Privacy rules (v2)

BurnWatch v2 is built so it cannot be used to watch individual people. Every route follows these rules. The plan and status live in `tasks/V2-NO-MICROMANAGEMENT-PLAN.md`.

1. **Groups for managers, self for people.** Admins and managers see team and org totals. Each person sees their own numbers in full. Nobody sees another person's usage numbers.
2. **Minimum group size of 5.** `MIN_GROUP_SIZE` in `packages/shared`. `readScope` (`apps/api/src/plugins/jwt.ts`) refuses a read that covers other people but fewer than 5 of them, and the route answers 403 `group_too_small`. Team compare leaves such teams out. The top-vs-rest split needs 17 people so the top quarter is itself 5.
3. **No ranking, scoring or streaks** shown to anyone but the person.
4. **Named lists only for admin operations, with symmetry.** Unused seats and setup checks may name a person to an admin. The person sees the same fact about themselves.
5. **People can see who looked** at data that covered them.
6. **Plain, neutral words.** No "score", "streak", "stuck", "missed", "violations", "leaderboard".

`npm run no-individuals -w @burn-watch/api` checks rules 1, 2 and 4 against a real MongoDB in CI. It calls every dashboard GET as admin, manager and developer and fails on any other person's id, name or email outside its allowlist. Its `KNOWN_LEAKS` list holds the routes that still break rule 1, and each phase removes its entries.

## System Overview

```
Developer machine                    Vercel                       Atlas
┌──────────────────┐                ┌──────────────────────┐
│ burnwatch agent  │───────────────▶│ burn-watch-api       │
│  usage     Tier 1│ POST /v1/usage │ Fastify 5 behind     │──┐
│  codeburn  Tier 2│                │ api/index.mjs        │  │
└──────────────────┘                └──────────────────────┘  │
                                              ▲                │  ┌─────────────┐
                                              │ GET /v1/       ├─▶│ MongoDB     │
┌──────────────────┐                ┌──────────────────────┐  │  └─────────────┘
│ Browser          │───────────────▶│ burn-watch           │──┘
└──────────────────┘                │ Next.js 15 dashboard │
                                    └──────────────────────┘
```

Two Vercel projects, one repository. The dashboard's server components call
the API for usage data and reach MongoDB directly for better-auth sessions.
There is no cache tier: Redis was removed in `57d9d0b`, and every dashboard
read goes to MongoDB on every request.

## Data Flow

1. **Collection** — Agent runs on developer machine (daily, via launchd on
   macOS, a systemd user timer on Linux, Task Scheduler on Windows)
   - **Tier 1 (usage):** Reads Claude Code's JSONL logs, counts each request once, prices it per request, and groups by UTC day, agent and model. No node, no third-party tool
   - **Tier 2 (codeburn):** Parses `~/.claude/projects/*/` JSONL files for Claude-specific enrichment (activity breakdown, project breakdown, tool/shell/MCP usage)

2. **Submission** — Agent POSTs collected data to `POST /v1/usage/submit` with device JWT
   - Events are upserted (deduped by userId + agent + date + modelName + deviceId)
   - Enrichment data stored in `claude_enrichment` table
   - `daily_snapshots` rebuilt synchronously after each submission

3. **Aggregation** — API serves dashboard queries from `daily_snapshots` table
   - All dashboard routes support date ranges (`from`/`to` params), validated
     by the shared schema in `routes/dashboard/query-schema.ts`
   - Activity and Projects aggregate `claudeEnrichment` documents in MongoDB
     via `routes/dashboard/enrichment.ts`, not in Node
   - Nothing is cached. Each request reads MongoDB.

4. **Display** — Next.js dashboard renders overview, trends, activity, and project breakdowns, plus a private "My usage" page for each person

## Component Breakdown

### `apps/agent` — Bun CLI

| File | Purpose |
|------|---------|
| `src/index.ts` | Commander CLI entry point (`register`, `sync`, `status`, `install-cron`, `uninstall`) |
| `src/commands/sync.ts` | Orchestrates both collectors, POSTs to API |
| `src/collectors/usage.ts` | Tier 1: runs each agent parser, dedupes, prices, groups by UTC day |
| `src/collectors/parsers/claude.ts` | Claude Code transcript parser, one record per request |
| `src/collectors/pricing.ts` | Embedded price table plus the daily `GET /v1/prices` refresh |
| `src/collectors/codeburn.ts` | Tier 2: parses JSONL files for Claude enrichment |
| `src/lib/cron.ts` | Dispatches the 6 PM daily sync schedule to a platform backend: launchd plist (macOS) |
| `src/lib/cron-linux.ts` | Schedule backend: systemd user service + timer (Linux) |
| `src/lib/cron-windows.ts` | Schedule backend: Task Scheduler XML task (Windows) |

### `apps/api` — Fastify 5

| File | Purpose |
|------|---------|
| `src/build-server.ts` | `configureServer()`, plugin and route registration, no `listen` |
| `src/server.ts` | Local entry point that calls `listen` |
| `api/index.mjs` | Vercel entry point, repo root, wraps Fastify in a plain `@vercel/node` function |
| `src/plugins/jwt.ts` | Dual JWT setup (access + refresh namespaces) |
| `src/plugins/rate-limit-store.ts` | Rate limit counters in MongoDB (`rateLimits`), shared across instances |
| `src/routes/auth/device.ts` | Device registration, verification, admin user management |
| `src/routes/usage/submit.ts` | Usage event ingestion + snapshot rebuild, one transaction |
| `src/routes/dashboard/*.ts` | 5 query endpoints, plus `query-schema.ts` and `enrichment.ts` shared by them |

### `apps/dashboard` — Next.js 15

| File | Purpose |
|------|---------|
| `src/app/(dashboard)/page.tsx` | Overview (summary cards, agent breakdown) |
| `src/app/(dashboard)/me/page.tsx` | My usage: the signed-in person's own numbers |
| `src/app/(dashboard)/trends/page.tsx` | Burn trend chart |
| `src/app/(dashboard)/activity/page.tsx` | Activity breakdown (Claude enrichment) |
| `src/app/(dashboard)/projects/page.tsx` | Project cost breakdown |
| `src/app/(dashboard)/admin/page.tsx` | Admin panel (invite form) |
| `src/components/DateRangePicker.tsx` | Date range selector with presets |
| `src/lib/api.ts` | Server-side API client |
| `src/lib/session.ts` | Session/role helpers |
| `src/lib/auth.ts` | better-auth server config |

### `packages/shared` — Shared Types

| File | Purpose |
|------|---------|
| `src/types.ts` | All TypeScript interfaces |
| `src/schemas.ts` | Zod validation schemas |

## Database Schema

Key tables:

| Table | Purpose |
|-------|---------|
| `organizations` | Multi-tenant org container |
| `users` | Developers (unique email per org) |
| `devices` | Registered agent machines |
| `device_tokens` | JWT token hashes for revocation |
| `pending_devices` | Verification codes (15-min expiry) |
| `usage_events` | Raw per-model usage data (deduped) |
| `claude_enrichment` | JSONB enrichment (activity, projects, tools) |
| `daily_snapshots` | Pre-aggregated per-user daily totals |
| `budget_alerts` | Configurable spend thresholds |

## Auth Flows

### Device Registration (Agent → API)

1. Admin invites user via `POST /v1/admin/users` (requires admin JWT)
2. Developer runs `burnwatch register` — enters email
3. Agent calls `POST /v1/auth/register-device` → receives 6-char verification code
4. Admin approves via `POST /v1/auth/verify-device` → agent receives JWT tokens
5. Tokens stored in `~/.burnwatch/config.json` (chmod 600)

### Dashboard Login (Human → Dashboard)

1. better-auth handles email/password login
2. Session cookie (`session_token`) set on dashboard domain
3. Next.js middleware checks session cookie presence
4. Role-based access enforced at page level (`getUserRole()`)
5. API calls use `bw-api-token` cookie as Bearer token

## Deployment

Two Vercel projects build from this one repository. Neither is wired to a git
push; both are deployed from a local checkout with the CLI, which is why the
link step below is part of the procedure rather than a one-time setup.

| Project | Config | Builds | Serves |
|---------|--------|--------|--------|
| `burn-watch-api` | `vercel.json` at the repo root | `npx turbo build --filter=@burn-watch/api` | Everything rewritten to `/api`, handled by `api/index.mjs` |
| `burn-watch` | `apps/dashboard/vercel.json` | `npx turbo build --filter=@burn-watch/dashboard` | The Next.js dashboard |

```bash
# API
npx vercel link --yes --project burn-watch-api && npx vercel --prod --yes

# Dashboard
npx vercel link --yes --project burn-watch && npx vercel --prod --yes
```

Because both projects link from the same directory, `vercel link` rewrites
`.env.local` each time. Deploy one, then relink for the other.

`api/index.mjs` deliberately avoids Vercel's Fastify framework preset, which
failed with `INTERNAL_FUNCTION_INVOCATION_FAILED` and no log output. A plain
`@vercel/node` function wrapping Fastify works. The file carries the full
reasoning.

Environment variables actually read by the code:

| Project | Variables |
|---------|-----------|
| `burn-watch-api` | `MONGODB_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PORT`, `NODE_ENV` |
| `burn-watch` | `API_URL`, `MONGODB_URI`, `JWT_SECRET`, `NODE_ENV` |

There is no `REDIS_URL`. Deployment protection is off for `burn-watch-api` so
the agent CLI can reach it without a bypass token.

## Setup (Quickstart)

Walked end to end on a clean clone against an empty database on 2026-11-06.
Two steps below exist because that walk failed without them: building
`shared` and configuring the dashboard. All
commands run from the repo root unless they say otherwise, and the two servers
each need their own terminal.

```bash
# 1. Clone and install
git clone <repo> && cd burn-watch
npm install

# 2. Build the shared package
# The API imports @burn-watch/shared from its built dist/. Without this the
# API exits at startup with ERR_MODULE_NOT_FOUND, not a helpful message.
npx turbo build --filter=@burn-watch/shared

# 3. Configure API
cp apps/api/.env.example apps/api/.env
# Fill: MONGODB_URI, JWT_SECRET, JWT_REFRESH_SECRET
# MONGODB_URI must name the database (`.../burnwatch`). Without one the driver
# uses `test`.
# Ignore REDIS_URL, CORS_ORIGIN and COPILOT_ENCRYPTION_KEY — nothing reads
# them. See BW-07 and BW-21.

# 4. Configure dashboard
# The dashboard talks to MongoDB directly for better-auth, so it needs its own
# env. Skip this and the app starts, serves /login, and answers 500 on every
# sign-in attempt.
cp apps/dashboard/.env.local.example apps/dashboard/.env.local
# Fill: API_URL (http://localhost:3001), MONGODB_URI (same as the API),
# JWT_SECRET (must match the API's), BETTER_AUTH_SECRET (any random string)

# 5. Create collections and indexes
# better-auth needs no setup step: its MongoDB adapter creates user, session,
# account and verification on first write.
MONGODB_URI=... npm run sync -w packages/db

# 6. Start API (own terminal, stays running)
cd apps/api && npm run dev

# 7. Bootstrap first org + admin
curl -X POST http://localhost:3001/v1/auth/admin/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{"orgName":"Acme","orgSlug":"acme","email":"admin@acme.com","name":"Admin"}'

# 8. Start dashboard (own terminal, stays running)
cd apps/dashboard && npm run dev

# 9. Set the admin's password
# Step 8 creates the users row; it does not create a login. Open
# http://localhost:3000/signup and submit the same email with a password.
# /login will not work before this — there is nothing to authenticate against.

# 10. Register agent on dev machine
# This blocks. It prints a six-character code and waits for a human to approve
# it at the dashboard's Devices page — signed in as the same email. The device
# is never issued tokens until someone does. See BW-30.
#
# It also overwrites ~/.burnwatch/config.json without asking. If this machine
# already reports to another BurnWatch, copy that file somewhere first.
cd apps/agent && bun run src/index.ts register --api-url http://localhost:3001

# 11. Sync usage data
# A bare `sync` writes yesterday, so the dashboard will not show today until
# tomorrow. Use --days to backfill a window.
bun run src/index.ts sync --days 7
```
