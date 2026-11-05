# Installing BurnWatch

Two audiences. Developers set up the agent on one laptop; admins onboard the
team and read the numbers.

Production:

| Piece | URL |
| --- | --- |
| Dashboard | https://burn-watch-delta.vercel.app |
| API | https://burn-watch-api.vercel.app |

The same page lives inside the dashboard at `/setup`, so an admin can send the
link instead of this file.

---

## For developers

Takes about five minutes. After that the agent reports on its own every evening.

### 1. Get your account

An admin adds your work email on the dashboard's Admin page. Until that happens
nothing else works. `burnwatch register` answers `User not found. Ask your
admin to invite you first.`

Once you are added, open the dashboard, click **Set your password**, and use the
same work email. There is no open sign-up: the password form only accepts an
email that is already in BurnWatch.

### 2. Install Bun

Skip this if `bun --version` already answers.

```bash
curl -fsSL https://bun.sh/install | bash
```

### 3. Build the agent

```bash
git clone git@github.com:iamakbarsha1/burn-watch.git ~/burn-watch
cd ~/burn-watch
npm install
cd apps/agent && bun run build
sudo mv dist/burnwatch /usr/local/bin/burnwatch
```

`bun run build` compiles one binary. Nothing from `node_modules` is needed at
runtime.

### 4. Register the machine

```bash
burnwatch register
```

It asks for your work email, prints a six-character code, and waits. Open
**Devices** in the dashboard and type the code in. The agent picks up the
approval within ten seconds and writes `~/.burnwatch/config.json` (mode 600).

The code lasts 15 minutes and works once. Only you can approve your own device, because
the approval is matched against the email you signed in with.

### 5. Backfill

```bash
burnwatch sync --days 30
```

This reads what ccusage already knows about Claude Code, Codex, Gemini, Qwen and
Copilot on this machine and uploads the daily totals. `--days 240` gets your
whole history.

### 6. Confirm

```bash
burnwatch status
```

Then open the dashboard's Overview page. Your numbers should be there.

### 7. Daily sync

On macOS, `register` already scheduled a 6 PM launchd job. If you moved the
binary after registering, repoint it:

```bash
burnwatch install-cron
```

Linux has no launchd, so add a crontab line instead:

```bash
(crontab -l 2>/dev/null; echo "0 18 * * * /usr/local/bin/burnwatch sync") | crontab -
```

Bare `sync` uploads yesterday. Today's spend appears tomorrow evening; run
`burnwatch sync --days 1` when you want it now.

### Removing it

```bash
burnwatch uninstall
```

Drops the schedule. `~/.burnwatch/config.json` stays, so delete it too if you
want nothing left behind.

### What gets uploaded

- Per-day token counts and cost, per agent and model.
- Project names and session counts, for the Projects and Activity pages.
- Hostname, platform and agent version, so a machine that stopped reporting is
  identifiable.

The agent never reads or sends prompts, responses or file contents.

### When it goes wrong

| Message | Cause |
| --- | --- |
| `User not found. Ask your admin to invite you first.` | Your email is not in BurnWatch, or you typed a different one. |
| `Invalid or expired verification code` | Codes last 15 minutes and work once. Run `register` again. |
| 6 PM job never fires | Run `burnwatch install-cron`. A plist written by an older agent points at the Bun runtime rather than the binary and dies with `Script not found "sync"`. |
| Dashboard still empty after a sync | Check `~/.burnwatch/agent.log`, then `burnwatch status` for the last successful upload. |

---

## For admins

### Adding people

Admin page → **Invite Developer** → name and work email. That creates the
BurnWatch user straight away. Send them the dashboard link and point them at
`/setup`.

The **Team** table on the same page lists everyone in the org, including people
who have not installed anything yet:

| Column | Reads |
| --- | --- |
| Status | `Active` once a device exists, `Not set up` until then, `Disabled` for a deactivated user |
| Devices | How many machines report, and their hostnames |
| Last sync | The most recent day with data, and how long ago the device checked in |
| Days / Tokens / Spend | All-time totals from the daily snapshots |

`Not set up` is the number that matters during rollout: those are the people who
have an account but have never run the agent.

### First-run bootstrap

A brand-new deployment has no org and no admin. One call creates both, and only
works while the database holds zero organizations:

```bash
curl -X POST https://burn-watch-api.vercel.app/v1/auth/admin/bootstrap \
  -H 'content-type: application/json' \
  -d '{"orgName":"Acme","orgSlug":"acme","email":"admin@acme.com","name":"Admin"}'
```

Then set a password for that email on the dashboard's sign-up page.

### Where the numbers come from

ccusage is the source for cost and tokens across all five agents. The Claude
JSONL parse only adds project, session and tool breakdowns, and never
contributes a cost figure. Agents on a free tier (Qwen) report tokens with zero
cost, so the Overview page shows them by token volume and leaves them out of
spend totals.
