# BurnWatch Architecture

## What is BurnWatch?

BurnWatch is an AI token usage dashboard for engineering organizations. It tracks per-developer spend across multiple AI agents (Claude, Qwen, Gemini, Codex, Copilot) and surfaces cost visibility for management.

Target: companies with 50+ developers using AI coding assistants.

## System Overview

```
Developer Machines                    Infrastructure
┌─────────────────┐                  ┌──────────────────┐
│  burnwatch agent │──POST /v1/usage──▶│   Fastify API    │
│  (Bun CLI)       │                  │   (port 3001)    │
│                  │                  │                  │
│  ┌─────────────┐ │                  │  ┌────────────┐  │
│  │ ccusage     │ │                  │  │ Drizzle ORM│  │
│  │ (Tier 1)    │ │                  │  └─────┬──────┘  │
│  └─────────────┘ │                  │        │         │
│  ┌─────────────┐ │                  │        ▼         │
│  │ codeburn    │ │                  │  ┌──────────┐    │
│  │ (Tier 2)    │ │                  │  │ Neon PG  │    │
│  └─────────────┘ │                  │  └──────────┘    │
└─────────────────┘                  │                  │
                                     │  ┌──────────┐    │
┌─────────────────┐                  │  │  Redis   │    │
│  Next.js Dash   │──GET /v1/dash──▶ │  │ (cache)  │    │
│  (port 3000)    │                  │  └──────────┘    │
└─────────────────┘                  └──────────────────┘
```

## Data Flow

1. **Collection** — Agent runs on developer machine (daily via launchd)
   - **Tier 1 (ccusage):** Runs `npx ccusage@latest daily --json` to get token counts and costs for all agents
   - **Tier 2 (codeburn):** Parses `~/.claude/projects/*/` JSONL files for Claude-specific enrichment (activity breakdown, project breakdown, tool/shell/MCP usage)

2. **Submission** — Agent POSTs collected data to `POST /v1/usage/submit` with device JWT
   - Events are upserted (deduped by userId + agent + date + modelName + deviceId)
   - Enrichment data stored in `claude_enrichment` table
   - `daily_snapshots` rebuilt synchronously after each submission

3. **Aggregation** — API serves dashboard queries from `daily_snapshots` table
   - All dashboard routes support date ranges (`from`/`to` params)
   - Results cached in Redis (5-minute TTL)

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
| `src/server.ts` | App bootstrap, plugin registration |
| `src/plugins/jwt.ts` | Dual JWT setup (access + refresh namespaces) |
| `src/plugins/db.ts` | Drizzle + Neon connection pool |
| `src/plugins/redis.ts` | ioredis connection with retry |
| `src/routes/auth/device.ts` | Device registration, verification, admin user management |
| `src/routes/usage/submit.ts` | Usage event ingestion + snapshot rebuild |
| `src/routes/dashboard/*.ts` | 5 dashboard query endpoints |
| `drizzle/schema.ts` | Full database schema (11 tables) |

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

## Setup (Quickstart)

```bash
# 1. Clone and install
git clone <repo> && cd burn-watch
npm install

# 2. Configure API
cp apps/api/.env.example apps/api/.env
# Fill: DATABASE_URL, REDIS_URL, JWT_SECRET

# 3. Push database schema
npm run db:push

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
bun run src/index.ts sync
```
