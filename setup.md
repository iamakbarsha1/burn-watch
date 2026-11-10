# Running BurnWatch locally

Bringing the monorepo up on your own machine. For installing the agent as a
developer, or onboarding the team, see [docs/INSTALL.md](docs/INSTALL.md).

Needs Node 20+ and Bun 1.3+.

## 1. Install dependencies

```bash
npm install
```

## 2. Point both apps at a database

One Neon database serves the API and the dashboard. The two secrets they share
have to match, or the dashboard signs you in and then cannot mint an API token.

```bash
cp apps/api/.env.example apps/api/.env
cp apps/dashboard/.env.local.example apps/dashboard/.env.local
```

| File | Fill |
| --- | --- |
| `apps/api/.env` | `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET` |
| `apps/dashboard/.env.local` | `DATABASE_URL`, `API_URL`, `JWT_SECRET`, `BETTER_AUTH_SECRET` |

`JWT_SECRET` and `DATABASE_URL` must be identical in both.

## 3. Create the schema

```bash
npm run db:migrate
```

`db:push` also exists and is fine against a scratch branch, but it writes no
row to `drizzle.__drizzle_migrations`, so a database brought up that way reads
as un-migrated to the `/health` schema check added in BW-37. Use `db:migrate`.

## 4. Create the first org and admin

Only works while the database holds zero organizations.

```bash
curl -X POST http://localhost:3001/v1/auth/admin/bootstrap \
  -H 'content-type: application/json' \
  -d '{"orgName":"Acme","orgSlug":"acme","email":"admin@acme.com","name":"Admin"}'
```

Then set a password for that email at `/signup` on the dashboard. Sign-up is
gated: the route answers 403 for any email without an active `users` row.

## 5. Start everything

```bash
npm run dev
```

Runs the API on 3001 and the dashboard on 3000 in parallel. To run one on its
own, `npm run dev` inside `apps/api` or `apps/dashboard`.

## 6. Register the agent against localhost

```bash
cd apps/agent
bun run src/index.ts register --api-url http://localhost:3001
bun run src/index.ts sync --last-7
```

`sync` prints the host it resolved on its first line. Check it says localhost —
a stale `~/.burnwatch/config.json` is how a walkthrough's data ends up in
production (BW-38).

## 7. Schedule the daily sync (optional)

```bash
bun run src/index.ts install-cron
```

Runs `sync` at 6 PM daily, using whatever the OS provides:

| OS | Writes | Check it |
| --- | --- | --- |
| macOS | `~/Library/LaunchAgents/com.burnwatch.agent.plist` | `launchctl list \| grep com.burnwatch.agent` |
| Linux | `~/.config/systemd/user/burnwatch-sync.{service,timer}` | `systemctl --user status burnwatch-sync.timer` |
| Windows | Task Scheduler task `BurnWatchSync` | `schtasks /query /tn BurnWatchSync` |

Run it from the build you want scheduled: from source it schedules
`bun <entry> sync`, from a compiled binary it schedules `<binary> sync`.

`register` already installs the schedule on first registration, but only when
none exists. `install-cron` removes and rewrites unconditionally, so it is also
the repair for a plist written before BW-32 — that version scheduled
`process.execPath`, which from source is the bun runtime rather than burnwatch,
and the job dies at 6 PM with `error: Script not found "sync"`. Upgrading the
agent does not fix a plist already on disk.

Remove the schedule and revoke the device token:

```bash
bun run src/index.ts uninstall
```

The config file stays. Delete `~/.burnwatch/config.json`
(`%USERPROFILE%\.burnwatch\config.json` on Windows) if you want nothing left.

## Checks

```bash
npm run typecheck
npm test
```
