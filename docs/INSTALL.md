# Installing BurnWatch

Two audiences. Developers set up the agent on one laptop; admins onboard the
team and read the numbers.

Production:

| Piece | URL |
| --- | --- |
| Dashboard | https://burn-watch-delta.vercel.app |
| API | https://burn-watch-api.vercel.app |

The same page lives inside the dashboard at `/setup`, where it picks your OS
from the browser, so an admin can send the link instead of this file.

The agent runs on macOS, Linux and Windows. Steps 1, 2 and 7 differ per OS;
everything else is the same three commands everywhere.

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

macOS and Linux:

```bash
curl -fsSL https://bun.sh/install | bash
```

Windows, from PowerShell — reopen the window afterwards so `bun` is on your
PATH:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

### 3. Build the agent

`bun run build` compiles one binary. Nothing from `node_modules` is needed at
runtime.

macOS and Linux:

```bash
git clone git@github.com:iamakbarsha1/burn-watch.git ~/burn-watch
cd ~/burn-watch
npm install
cd apps/agent && bun run build
sudo mv dist/burnwatch /usr/local/bin/burnwatch
```

Windows, from PowerShell:

```powershell
git clone git@github.com:iamakbarsha1/burn-watch.git $HOME\burn-watch
cd $HOME\burn-watch
npm install
cd apps\agent
bun run build
New-Item -ItemType Directory -Force $HOME\bin | Out-Null
Move-Item -Force dist\burnwatch.exe $HOME\bin\burnwatch.exe
```

Nothing puts `$HOME\bin` on your PATH for you. Add it once, then reopen
PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('Path',
  "$([Environment]::GetEnvironmentVariable('Path','User'));$HOME\bin", 'User')
```

If you would rather not install Bun at all, ask an admin for a prebuilt binary
(see **Building for someone else's machine** below).

### 4. Register the machine

```bash
burnwatch register
```

It asks for your work email, prints a six-character code, and waits. Open
**Devices** in the dashboard and type the code in. The agent picks up the
approval within ten seconds and writes its config:

| OS | Config |
| --- | --- |
| macOS, Linux | `~/.burnwatch/config.json`, mode 600 |
| Windows | `%USERPROFILE%\.burnwatch\config.json` |

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

`register` already scheduled the 6 PM job, using whatever the OS provides.
Confirm it exists:

| OS | Scheduled as | Check it |
| --- | --- | --- |
| macOS | launchd agent `com.burnwatch.agent` | `launchctl list \| grep com.burnwatch.agent` |
| Linux | systemd user timer `burnwatch-sync.timer` | `systemctl --user status burnwatch-sync.timer` |
| Windows | Task Scheduler task `BurnWatchSync` | `schtasks /query /tn BurnWatchSync` |

If you moved the binary after registering, repoint the schedule at its new path:

```bash
burnwatch install-cron
```

On Linux a user timer needs a live user session. Over a bare SSH login there is
none, so enable lingering once and reinstall:

```bash
loginctl enable-linger $USER
burnwatch install-cron
```

Bare `sync` uploads yesterday. Today's spend appears tomorrow evening; run
`burnwatch sync --days 1` when you want it now.

Linux and Windows scheduling is generated and unit-tested, but nobody has
watched it fire on real hardware yet. If 6 PM comes and goes with nothing
uploaded, say so — that is the open item in the verification debt table in
[tasks/TICKETS.md](../tasks/TICKETS.md).

### Removing it

```bash
burnwatch uninstall
```

Drops the schedule and revokes the device token. The config file stays, so
delete it too if you want nothing left behind.

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
| `burnwatch: command not found` | The binary is not on your PATH. `which burnwatch` on macOS and Linux, `Get-Command burnwatch` in PowerShell. On Windows, PATH is read when the shell starts — reopen it after step 3. |
| 6 PM job never fires, macOS | Run `burnwatch install-cron`. A plist written by an older agent points at the Bun runtime rather than the binary and dies with `Script not found "sync"`. |
| 6 PM job never fires, Linux | `Failed to connect to bus` from `systemctl --user` means there is no user session holding the timer. `loginctl enable-linger $USER`, then `burnwatch install-cron`. |
| 6 PM job never fires, Windows | `ERROR: The system cannot find the file specified` from `schtasks /query` means the task was never created. Re-run `burnwatch install-cron` from PowerShell; the task belongs to the user who created it. |
| Dashboard still empty after a sync | Check `~/.burnwatch/agent.log` (`%USERPROFILE%\.burnwatch\agent.log` on Windows), then `burnwatch status` for the last successful upload. Run the sync by hand first — it shows the error the scheduler swallows. |

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

### Building for someone else's machine

Bun cross-compiles, so one machine can produce every binary. Run these from
`apps/agent`:

| Script | Output |
| --- | --- |
| `bun run build:darwin-arm64` | `dist/burnwatch-darwin-arm64` |
| `bun run build:darwin-x64` | `dist/burnwatch-darwin-x64` |
| `bun run build:linux-x64` | `dist/burnwatch-linux-x64` |
| `bun run build:windows-x64` | `dist/burnwatch-windows-x64.exe` |

Hand one over and the developer skips steps 2 and 3: drop it somewhere on PATH,
rename it to `burnwatch` (`burnwatch.exe` on Windows), make it executable with
`chmod +x` on macOS and Linux, and start at step 4.

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
