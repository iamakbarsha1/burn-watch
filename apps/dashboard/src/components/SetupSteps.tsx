'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card } from '@/components/ui'
import { detectOs, OS_LABELS, OS_ORDER, type Os } from '@/lib/os'

const REPO = 'git@github.com:iamakbarsha1/burn-watch.git'

const linkClass =
  'rounded text-brand underline-offset-4 transition-colors outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/50'

const POSIX_BUN = 'curl -fsSL https://bun.sh/install | bash'

const INSTALL_BUN: Record<Os, string> = {
  macos: POSIX_BUN,
  linux: POSIX_BUN,
  windows: 'powershell -c "irm bun.sh/install.ps1 | iex"',
}

const POSIX_BUILD = `git clone ${REPO} ~/burn-watch
cd ~/burn-watch
npm install
cd apps/agent && bun run build
sudo mv dist/burnwatch /usr/local/bin/burnwatch`

const BUILD: Record<Os, string> = {
  macos: POSIX_BUILD,
  linux: POSIX_BUILD,
  windows: String.raw`git clone ${REPO} $HOME\burn-watch
cd $HOME\burn-watch
npm install
cd apps\agent
bun run build
New-Item -ItemType Directory -Force $HOME\bin | Out-Null
Move-Item -Force dist\burnwatch.exe $HOME\bin\burnwatch.exe`,
}

const CONFIG_PATH: Record<Os, string> = {
  macos: '~/.burnwatch/config.json',
  linux: '~/.burnwatch/config.json',
  windows: String.raw`%USERPROFILE%\.burnwatch\config.json`,
}

const LOG_PATH: Record<Os, string> = {
  macos: '~/.burnwatch/agent.log',
  linux: '~/.burnwatch/agent.log',
  windows: String.raw`%USERPROFILE%\.burnwatch\agent.log`,
}

const SCHEDULER: Record<Os, { name: string; verify: string }> = {
  macos: { name: 'a launchd job', verify: 'launchctl list | grep com.burnwatch.agent' },
  linux: {
    name: 'a systemd user timer',
    verify: 'systemctl --user status burnwatch-sync.timer',
  },
  windows: { name: 'a Task Scheduler task', verify: 'schtasks /query /tn BurnWatchSync' },
}

export function SetupSteps({ email }: { email: string }) {
  // macOS is the server-rendered default; the effect corrects it on the first
  // client paint. Guessing in the render would mean a hydration mismatch, and
  // guessing from an Accept-CH header would mean a request round trip for
  // something a click already fixes.
  const [os, setOs] = useState<Os>('macos')
  useEffect(() => {
    const guess = detectOs(navigator.userAgent)
    if (guess) setOs(guess)
  }, [])

  const posix = os !== 'windows'
  const shell = os === 'windows' ? 'PowerShell' : 'a terminal'
  const schedule = SCHEDULER[os]

  return (
    <>
      <div
        role="radiogroup"
        aria-label="Operating system"
        className="mb-4 inline-flex rounded-lg border border-line bg-surface-2 p-1"
      >
        {OS_ORDER.map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={os === key}
            onClick={() => setOs(key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
              os === key
                ? 'bg-brand text-white'
                : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
            }`}
          >
            {OS_LABELS[key]}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        <Step n={1} title="Install Bun">
          <P>
            The agent is built with Bun. Skip this if <C>bun --version</C> already answers.
          </P>
          <Code>{INSTALL_BUN[os]}</Code>
          {os === 'windows' && (
            <P muted>
              Run it from PowerShell, then reopen the window so <C>bun</C> is on your PATH.
            </P>
          )}
        </Step>

        <Step n={2} title="Build the agent">
          <Code>{BUILD[os]}</Code>
          <P>
            <C>bun run build</C> compiles a single binary. It runs without Node or a
            node_modules tree.
          </P>
          {os === 'windows' && (
            <>
              <P>
                Nothing puts <C>$HOME\bin</C> on your PATH for you. Add it once, then reopen
                PowerShell:
              </P>
              <Code>
                {String.raw`[Environment]::SetEnvironmentVariable('Path',
  "$([Environment]::GetEnvironmentVariable('Path','User'));$HOME\bin", 'User')`}
              </Code>
              <P muted>
                No Bun and no appetite for one? Ask an admin to run{' '}
                <C>bun run build:windows-x64</C> on their machine and send you the{' '}
                <C>.exe</C>.
              </P>
            </>
          )}
        </Step>

        <Step n={3} title="Register this machine">
          <Code>burnwatch register</Code>
          <P>
            It asks for your work email. Use <strong className="text-ink">{email}</strong>, the
            same one you signed in with. It then prints a six-character code and waits. Open{' '}
            <Link href="/devices" className={linkClass}>
              Devices
            </Link>{' '}
            in this dashboard and enter that code. The agent picks up the approval within ten
            seconds and writes its config to <C>{CONFIG_PATH[os]}</C>.
          </P>
          <P muted>The code expires after 15 minutes, and only you can approve your own device.</P>
        </Step>

        <Step n={4} title="Backfill your history">
          <Code>burnwatch sync --days 30</Code>
          <P>
            Reads what ccusage already knows about Claude Code, Codex, Gemini, Qwen and Copilot
            on this machine and uploads the daily totals. Use <C>--days 240</C> if you want your
            whole history.
          </P>
        </Step>

        <Step n={5} title="Check it landed">
          <Code>burnwatch status</Code>
          <P>
            Then open{' '}
            <Link href="/" className={linkClass}>
              Overview
            </Link>
            . Your numbers should be there.
          </P>
        </Step>

        <Step n={6} title="Daily sync">
          <P>
            <C>register</C> already scheduled {schedule.name} for 6 PM. Confirm it exists:
          </P>
          <Code>{schedule.verify}</Code>
          <P>If you moved the binary after registering, repoint the schedule at its new path:</P>
          <Code>burnwatch install-cron</Code>
          {os === 'linux' && (
            <>
              <P>
                A user timer needs a live user session. Over a bare SSH login there is none, so
                enable lingering once and reinstall the schedule:
              </P>
              <Code>{'loginctl enable-linger $USER\nburnwatch install-cron'}</Code>
            </>
          )}
          <P muted>
            Bare <C>sync</C> uploads yesterday, so today&apos;s spend shows up tomorrow evening.
            Run <C>burnwatch sync --days 1</C> any time you want today&apos;s number now.
          </P>
          {os !== 'macos' && (
            <P muted>
              Nobody has watched {OS_LABELS[os]} scheduling fire on real hardware yet. If 6 PM
              comes and goes with nothing uploaded, say so.
            </P>
          )}
        </Step>
      </div>

      <Card className="mt-6 p-5 sm:p-6">
        <h2 className="text-sm font-semibold tracking-tight text-ink">What gets uploaded</h2>
        <ul className="mt-3 mb-3 list-disc space-y-1.5 pl-5 text-sm text-ink-2 marker:text-ink-3">
          <li>Per-day token counts and cost per agent and model.</li>
          <li>Project names and session counts, for the Projects and Activity pages.</li>
          <li>Your hostname, platform and agent version, so a stale machine is identifiable.</li>
        </ul>
        <P>
          The agent never reads or sends prompts, responses or file contents. Remove everything
          with <C>burnwatch uninstall</C>.
        </P>
      </Card>

      <Card className="mt-4 p-5 sm:p-6">
        <h2 className="mb-4 text-sm font-semibold tracking-tight text-ink">
          If something goes wrong
        </h2>
        <dl className="space-y-4">
          <Trouble problem="User not found. Ask your admin to invite you first.">
            Your email is not in BurnWatch yet, or you typed a different one. Ask an admin to add
            it on the Admin page.
          </Trouble>
          <Trouble problem="Invalid or expired verification code">
            Codes last 15 minutes and are single-use. Run <C>burnwatch register</C> again for a
            fresh one.
          </Trouble>
          <Trouble problem="burnwatch: command not found">
            {posix ? (
              <>
                The binary is not on your PATH. Check <C>which burnwatch</C>, and move it to{' '}
                <C>/usr/local/bin</C> if step 2&apos;s <C>sudo mv</C> was skipped.
              </>
            ) : (
              <>
                PowerShell resolves PATH when it starts. Reopen the window after step 2, then
                check <C>Get-Command burnwatch</C>.
              </>
            )}
          </Trouble>
          <Trouble problem="The 6 PM job never runs">
            Start with <C>{schedule.verify}</C>.{' '}
            {os === 'macos' && (
              <>
                Then run <C>burnwatch install-cron</C>. A plist written by an older agent points
                at the Bun runtime instead of the binary and dies with{' '}
                <C>Script not found &quot;sync&quot;</C>.
              </>
            )}
            {os === 'linux' && (
              <>
                <C>Failed to connect to bus</C> means there is no user session to hold the
                timer. Run <C>loginctl enable-linger $USER</C>, then{' '}
                <C>burnwatch install-cron</C>.
              </>
            )}
            {os === 'windows' && (
              <>
                <C>ERROR: The system cannot find the file specified</C> means the task was never
                created. Re-run <C>burnwatch install-cron</C> from PowerShell — the task belongs
                to the user who created it.
              </>
            )}
          </Trouble>
          <Trouble problem="Dashboard shows nothing after a sync">
            Check <C>{LOG_PATH[os]}</C>, then <C>burnwatch status</C> for the last successful
            upload. Run the sync by hand from {shell} first, to see the error the scheduler
            swallows.
          </Trouble>
        </dl>
      </Card>
    </>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="flex items-center gap-3 text-sm font-semibold tracking-tight text-ink">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white">
          {n}
        </span>
        {title}
      </h2>
      <div className="mt-3 space-y-3">{children}</div>
    </Card>
  )
}

function P({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <p className={`text-sm ${muted ? 'text-ink-3' : 'text-ink-2'}`}>{children}</p>
}

/** Inline code. `C` because it appears a few dozen times in this page's prose. */
function C({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-surface-0 px-1 py-0.5 font-mono text-xs text-ink">{children}</code>
  )
}

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-line bg-surface-0 p-3.5 font-mono text-xs leading-relaxed text-ink">
      <code>{children}</code>
    </pre>
  )
}

function Trouble({ problem, children }: { problem: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm font-medium text-ink">{problem}</dt>
      <dd className="mt-1 text-sm leading-relaxed text-ink-2">{children}</dd>
    </div>
  )
}
