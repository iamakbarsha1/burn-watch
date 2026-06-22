Next steps to run it

# 1. Install dependencies

npm install

# 2. Set up Neon DB + Redis (copy .env.example)

cp apps/api/.env.example apps/api/.env

# Fill DATABASE_URL, REDIS_URL, JWT_SECRET

# 3. Push DB schema

npm run db:push

# 4. Bootstrap first org + user (one-time)

curl -X POST http://localhost:3001/v1/admin/bootstrap \
 -H "Content-Type: application/json" \
 -d '{"orgName":"Acme Corp","orgSlug":"acme","email":"admin@acme.com","name":"Akbar"}'

# 5. Start API

cd apps/api && npm run dev

# 6. Register your device (agent CLI)

cd apps/agent && bun run src/index.ts register --api-url http://localhost:3001

# 7. Sync your data

bun run src/index.ts sync --last-7

# 8. Start dashboard

cd apps/dashboard && npm run dev

---

Next Prompt:
Run `npm install` and `npm run typecheck` at the monorepo root to verify zero type errors.
Fix any issues found. Then test the agent CLI with `burnwatch register` and `burnwatch sync --last-7` against a local API instance.

✻ Sautéed for 53s

⏺ All agents shut down cleanly. Updating memory:

⏺ Wrote 1 memory (ctrl+o to expand)

⏺ Team shut down cleanly. Implementation complete.

---

Completed:

- 39 files across monorepo
- Agent CLI typechecked clean (confirmed by agent-dev)
- API implemented with zero errors (confirmed by api-dev)
- Dashboard 15 files with dark theme + Recharts charts

Remains:

- npm install at root
- Provision Neon DB + Upstash Redis
- npm run db:push to migrate schema
- Bootstrap first org via POST /v1/admin/bootstrap
- End-to-end smoke test

---

Next Prompt:
Run `npm install` then `npm run typecheck` at /Users/akbarsha/Documents/code/burn-watch.
Fix any TypeScript errors found. Then test the agent sync flow end-to-end:

1. Start API locally (apps/api npm run dev)
2. Bootstrap org (POST /v1/admin/bootstrap)
3. burnwatch register --api-url http://localhost:3001
4. burnwatch sync --last-7
5. Verify daily_snapshots populated in Neon DB
