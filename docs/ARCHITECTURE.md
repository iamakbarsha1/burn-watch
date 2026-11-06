# BurnWatch Architecture

## What is BurnWatch?

BurnWatch is an AI token usage dashboard for engineering organizations. It tracks per-developer spend across multiple AI agents (Claude, Qwen, Gemini, Codex, Copilot) and surfaces cost visibility for management.

Target: companies with 50+ developers using AI coding assistants.

## System Overview

```
Developer machine                    Vercel                       Neon
┌──────────────────┐                ┌──────────────────────┐
│ burnwatch agent  │───────────────▶│ burn-watch-api       │
│  ccusage   Tier 1│ POST /v1/usage │ Fastify 5 behind     │──┐
│  codeburn  Tier 2│                │ api/index.mjs        │  │
└──────────────────┘                └──────────────────────┘  │
                                              ▲                │  ┌─────────────┐
                                              │ GET /v1/       ├─▶│ PostgreSQL  │
┌──────────────────┐                ┌──────────────────────┐  │  └─────────────┘
│ Browser          │───────────────▶│ burn-watch           │──┘
└──────────────────┘                │ Next.js 15 dashboard │
                                    └──────────────────────┘
```

Two Vercel projects, one repository. The dashboard's server components call
the API for usage data and reach Neon directly for better-auth sessions.
There is no cache tier: Redis was removed in `57d9d0b`, and every dashboard
read goes to Postgres on every request.

## Data Flow

1. **Collection** — Agent runs on developer machine (daily via launchd)
   - **Tier 1 (ccusage):** Runs `npx ccusage@latest daily --json` to get token counts and costs for all agents
   - **Tier 2 (codeburn):** Parses `~/.claude/projects/*/` JSONL files for Claude-specific enrichment (activity breakdown, project breakdown, tool/shell/MCP usage)

2. **Submission** — Agent POSTs collected data to `POST /v1/usage/submit` with device JWT
   - Events are upserted (deduped by userId + agent + date + modelName + deviceId)
   - Enrichment data stored in `claude_enrichment` table
   - `daily_snapshots` rebuilt synchronously after each submission

3. **Aggregation** — API serves dashboard queries from `daily_snapshots` table
   - All dashboard routes support date ranges (`from`/`to` params), validated
     by the shared schema in `routes/dashboard/query-schema.ts`
   - Activity and Projects aggregate the `claude_enrichment` JSONB in Postgres
     via `routes/dashboard/enrichment.ts`, not in Node
   - Nothing is cached. Each request reads Postgres.

4. **Display** — Next.js dashboard renders overview, leaderboard, trends, activity, and project breakdowns

## Component Breakdown

### `apps/agent` — Bun CLI

| File | Purpose |
|------|---------|
| `src/index.ts` | Commander CLI entry point (`register`, `sync`, `status`, `install-cron`, `uninstall`) |
| `src/commands/sync.ts` | Orchestrates both collectors, POSTs to API |
| `src/collectors/ccusage.ts` | Tier 1: runs ccusage CLI, parses JSON output |
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
| `src/plugins/db.ts` | Drizzle + Neon connection pool |
| `src/plugins/rate-limit-store.ts` | Rate limit counters in Postgres, shared across instances |
| `src/routes/auth/device.ts` | Device registration, verification, admin user management |
| `src/routes/usage/submit.ts` | Usage event ingestion + snapshot rebuild, one transaction |
| `src/routes/dashboard/*.ts` | 5 query endpoints, plus `query-schema.ts` and `enrichment.ts` shared by them |
| `drizzle/schema.ts` | Full database schema (11 tables) |
| `drizzle/migrations/` | Generated migrations. `db:push` is not used against deployed databases |

### `apps/dashboard` — Next.js 15

| File | Purpose |
|------|---------|
| `src/app/(dashboard)/page.tsx` | Overview (summary cards, agent breakdown) |
| `src/app/(dashboard)/users/page.tsx` | Developer leaderboard |
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
| `burn-watch-api` | `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `PORT`, `NODE_ENV` |
| `burn-watch` | `API_URL`, `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV` |

There is no `REDIS_URL`. Deployment protection is off for `burn-watch-api` so
the agent CLI can reach it without a bypass token.

## Setup (Quickstart)

```bash
# 1. Clone and install
git clone <repo> && cd burn-watch
npm install

# 2. Configure API
cp apps/api/.env.example apps/api/.env
# Fill: DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET

# 3. Apply database migrations
npm run db:migrate

# 4. Start API
cd apps/api && npm run dev

# 5. Bootstrap first org + admin
curl -X POST http://localhost:3001/v1/auth/admin/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{"orgName":"Acme","orgSlug":"acme","email":"admin@acme.com","name":"Admin"}'

# 6. Start dashboard
cd apps/dashboard && npm run dev

# 7. Register agent on dev machine
cd apps/agent && bun run src/index.ts register --api-url http://localhost:3001

# 8. Sync usage data
# A bare `sync` writes yesterday, so the dashboard will not show today until
# tomorrow. Use --days to backfill a window.
bun run src/index.ts sync --days 7
```
