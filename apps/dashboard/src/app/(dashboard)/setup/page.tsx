import Link from 'next/link'
import { getSession } from '@/lib/session'

const REPO = 'git@github.com:iamakbarsha1/burn-watch.git'

export default async function SetupPage() {
  const session = await getSession()
  const email = session?.user?.email ?? 'you@company.com'

  return (
    <div style={{ maxWidth: '820px' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Set up BurnWatch on your laptop</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>
        Five minutes, once. After that the agent reports yesterday&apos;s usage every evening on its own.
      </p>

      <Step n={1} title="Install Bun">
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          The agent is built with Bun. Skip this if <code>bun --version</code> already answers.
        </p>
        <Code>curl -fsSL https://bun.sh/install | bash</Code>
      </Step>

      <Step n={2} title="Build the agent">
        <Code>{`git clone ${REPO} ~/burn-watch
cd ~/burn-watch
npm install
cd apps/agent && bun run build
sudo mv dist/burnwatch /usr/local/bin/burnwatch`}</Code>
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: '0.75rem' }}>
          <code>bun run build</code> compiles a single binary. It runs without Node or a node_modules tree.
        </p>
      </Step>

      <Step n={3} title="Register this machine">
        <Code>burnwatch register</Code>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginTop: '0.75rem' }}>
          It asks for your work email. Use <strong style={{ color: 'var(--text)' }}>{email}</strong>, the
          same one you signed in with. It then prints a six-character code and waits.
          Open <Link href="/devices" style={{ color: 'var(--primary)' }}>Devices</Link> in this dashboard
          and enter that code. The agent picks up the approval within ten seconds and writes its
          config to <code>~/.burnwatch/config.json</code>.
        </p>
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
          The code expires after 15 minutes, and only you can approve your own device.
        </p>
      </Step>

      <Step n={4} title="Backfill your history">
        <Code>burnwatch sync --days 30</Code>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginTop: '0.75rem' }}>
          Reads what ccusage already knows about Claude Code, Codex, Gemini, Qwen and Copilot on
          this machine and uploads the daily totals. Use <code>--days 240</code> if you want your
          whole history.
        </p>
      </Step>

      <Step n={5} title="Check it landed">
        <Code>burnwatch status</Code>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginTop: '0.75rem' }}>
          Then open <Link href="/" style={{ color: 'var(--primary)' }}>Overview</Link>. Your numbers
          should be there.
        </p>
      </Step>

      <Step n={6} title="Daily sync">
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          On macOS <code>register</code> already scheduled a 6 PM launchd job. If you moved the
          binary afterwards, repoint it:
        </p>
        <Code>burnwatch install-cron</Code>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginTop: '0.75rem' }}>
          On Linux there is no launchd, so add a crontab line instead:
        </p>
        <Code>{`(crontab -l 2>/dev/null; echo "0 18 * * * /usr/local/bin/burnwatch sync") | crontab -`}</Code>
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: '0.75rem' }}>
          Bare <code>sync</code> uploads yesterday, so today&apos;s spend shows up tomorrow evening.
          Run <code>burnwatch sync --days 1</code> any time you want today&apos;s number now.
        </p>
      </Step>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.5rem', marginTop: '2rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>What gets uploaded</h2>
        <ul style={{ color: 'var(--muted)', fontSize: '0.9rem', lineHeight: 1.7, paddingLeft: '1.25rem' }}>
          <li>Per-day token counts and cost per agent and model.</li>
          <li>Project names and session counts, for the Projects and Activity pages.</li>
          <li>Your hostname, platform and agent version, so a stale machine is identifiable.</li>
        </ul>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginTop: '0.75rem' }}>
          The agent never reads or sends prompts, responses or file contents. Remove everything with{' '}
          <code>burnwatch uninstall</code>.
        </p>
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.5rem', marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>If something goes wrong</h2>
        <Trouble problem="User not found. Ask your admin to invite you first.">
          Your email is not in BurnWatch yet, or you typed a different one. Ask an admin to add it
          on the Admin page.
        </Trouble>
        <Trouble problem="Invalid or expired verification code">
          Codes last 15 minutes and are single-use. Run <code>burnwatch register</code> again for a
          fresh one.
        </Trouble>
        <Trouble problem="The 6 PM job never runs">
          Run <code>burnwatch install-cron</code>. A plist written by an older agent points at the
          Bun runtime instead of the binary and dies with <code>Script not found &quot;sync&quot;</code>.
        </Trouble>
        <Trouble problem="Dashboard shows nothing after a sync">
          Check <code>~/.burnwatch/agent.log</code>, then <code>burnwatch status</code> for the last
          successful upload.
        </Trouble>
      </div>
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.5rem', marginBottom: '1rem' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <span style={{ background: 'var(--primary)', color: 'white', width: '1.6rem', height: '1.6rem', borderRadius: '999px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', flexShrink: 0 }}>
          {n}
        </span>
        {title}
      </h2>
      {children}
    </div>
  )
}

function Code({ children }: { children: string }) {
  return (
    <pre style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.9rem', overflowX: 'auto', fontSize: '0.85rem', lineHeight: 1.6, margin: 0 }}>
      <code>{children}</code>
    </pre>
  )
}

function Trouble({ problem, children }: { problem: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>{problem}</div>
      <div style={{ color: 'var(--muted)', fontSize: '0.85rem', lineHeight: 1.6 }}>{children}</div>
    </div>
  )
}
