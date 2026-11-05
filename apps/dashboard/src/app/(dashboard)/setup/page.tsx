import Link from 'next/link'
import { getSession } from '@/lib/session'
import { PageHeader, Card } from '@/components/ui'

const REPO = 'git@github.com:iamakbarsha1/burn-watch.git'

const linkClass =
  'rounded text-brand underline-offset-4 transition-colors outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/50'

export default async function SetupPage() {
  const session = await getSession()
  const email = session?.user?.email ?? 'you@company.com'

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Set up BurnWatch on your laptop"
        subtitle="Five minutes, once. After that the agent reports yesterday's usage every evening on its own."
      />

      <div className="space-y-3">
        <Step n={1} title="Install Bun">
          <P>
            The agent is built with Bun. Skip this if <C>bun --version</C> already answers.
          </P>
          <Code>curl -fsSL https://bun.sh/install | bash</Code>
        </Step>

        <Step n={2} title="Build the agent">
          <Code>{`git clone ${REPO} ~/burn-watch
cd ~/burn-watch
npm install
cd apps/agent && bun run build
sudo mv dist/burnwatch /usr/local/bin/burnwatch`}</Code>
          <P>
            <C>bun run build</C> compiles a single binary. It runs without Node or a
            node_modules tree.
          </P>
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
            seconds and writes its config to <C>~/.burnwatch/config.json</C>.
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
            On macOS <C>register</C> already scheduled a 6 PM launchd job. If you moved the
            binary afterwards, repoint it:
          </P>
          <Code>burnwatch install-cron</Code>
          <P>On Linux there is no launchd, so add a crontab line instead:</P>
          <Code>{`(crontab -l 2>/dev/null; echo "0 18 * * * /usr/local/bin/burnwatch sync") | crontab -`}</Code>
          <P muted>
            Bare <C>sync</C> uploads yesterday, so today&apos;s spend shows up tomorrow evening.
            Run <C>burnwatch sync --days 1</C> any time you want today&apos;s number now.
          </P>
        </Step>
      </div>

      <Card className="mt-6 p-5 sm:p-6">
        <h2 className="text-sm font-semibold tracking-tight text-ink">What gets uploaded</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-ink-2 marker:text-ink-3">
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
          <Trouble problem="The 6 PM job never runs">
            Run <C>burnwatch install-cron</C>. A plist written by an older agent points at the Bun
            runtime instead of the binary and dies with <C>Script not found &quot;sync&quot;</C>.
          </Trouble>
          <Trouble problem="Dashboard shows nothing after a sync">
            Check <C>~/.burnwatch/agent.log</C>, then <C>burnwatch status</C> for the last
            successful upload.
          </Trouble>
        </dl>
      </Card>
    </div>
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
