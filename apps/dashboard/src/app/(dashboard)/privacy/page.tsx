import { MIN_GROUP_SIZE } from '@burn-watch/shared'
import { Badge, PageHeader, Section, TableFrame, Td, Th, Tr } from '@/components/ui'
import { AUDIENCE, FIELD_GROUPS, audienceOf, type Audience } from '@/lib/transparency'

const NEVER = [
  'Your prompts, or what the model writes back',
  'Source code or the contents of any file',
  'File paths. Repositories are sent by name and Git remote only',
  'Shell command arguments. Only the first word is counted (git, npm, ...)',
  'Your raw Claude account ID. It is hashed on your laptop before it is sent',
]

const WONT = [
  'Rank people against each other.',
  'Give anyone a number that rates them.',
  'Show one person\'s usage to a manager.',
  'Read your prompts or your code.',
]

// What GET routes an admin can call return about one named person. Kept in step
// with ALLOWED and KNOWN_FIELDS in apps/api/src/scripts/no-individuals.ts.
const ADMIN_SEES = [
  'Your name, email and role, and whether your login is turned on.',
  'The date your account was made.',
  'Your laptops: how many, their names and operating system, and the agent and Claude Code versions on each.',
  'Whether your agent has sent anything in the last 7 days, per laptop on Devices and overall on Admin. Not when.',
  'The teams you are in, and whether you manage one.',
  'Your paid seats: agent, monthly price and start date.',
  'On Unused seats: that a paid seat of yours has gone unused, in steps like 30+ or 60+ days. Not the exact count.',
  'On Setup checks: an agent or model you used outside the org\'s rules. Not how much or when.',
]

const SEES: Record<Audience, [boolean, boolean, boolean]> = {
  scoped: [true, true, true],
  self: [true, false, false],
  selfAdmin: [true, false, true],
  admin: [false, false, true],
  none: [false, false, false],
}

function Cell({ yes }: { yes: boolean }) {
  return <Td>{yes ? <Badge tone="good">Yes</Badge> : <Badge>No</Badge>}</Td>
}

export default function PrivacyPage() {
  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title="What BurnWatch knows about me"
        subtitle="Every field the agent on your laptop can send, the choices you make here, and who can see each one. This list is built from the schemas the server checks every upload and change against."
      />

      <Section title="Never collected">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          {NEVER.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Section>

      <Section title="What BurnWatch will never do">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          {WONT.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Section>

      <Section
        title="What an admin sees about you"
        description="Admins manage logins, laptops and seats, so some pages name you. This is all of it. Admins never see your cost, tokens or active days anywhere else, and no list sorts people by usage."
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          {ADMIN_SEES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-ink-2">
          An admin can delete you. That removes your usage history, daily totals, seats, team places,
          laptops and their tokens, invites and your login. It cannot be undone. Past org and team totals
          drop by your share. The audit log keeps its rows about you.
        </p>
      </Section>

      <p className="text-sm text-ink-2">
        <strong className="text-ink">Your manager</strong> means a manager of a team you are in.
        Fields marked <em>stored, not shown</em> are kept but no page or API route returns them
        yet. Admins with database access can still read them.
      </p>

      <p className="text-sm text-ink-2">
        Admins can see a log of who opened views that include team or person data. You can see who
        viewed data that includes you under Who viewed my data on My usage.
      </p>

      <p className="text-sm text-ink-2">
        Totals for a team, for the teams a manager runs, or for a whole org, are hidden when they cover fewer
        than {MIN_GROUP_SIZE} people. So are the days, tokens, calls and shares on any row inside them that covers
        fewer than {MIN_GROUP_SIZE}, such as a model or MCP server only one person used: the row shows how many people,
        nothing more. A small team, org or row cannot be used to read one person&apos;s numbers.
      </p>

      {FIELD_GROUPS.map((group) => (
        <section key={group.title}>
          <h2 className="text-sm font-semibold tracking-tight text-ink">{group.title}</h2>
          <p className="mt-1 mb-3 text-sm text-ink-2">{group.description}</p>
          <TableFrame>
            <table className="w-full border-collapse">
              <thead className="bg-surface-2">
                <tr>
                  <Th>Field</Th>
                  <Th>What it is</Th>
                  <Th>You</Th>
                  <Th>Your manager</Th>
                  <Th>Admins</Th>
                </tr>
              </thead>
              <tbody>
                {group.fields.map((f) => {
                  // shortcut: a missing entry shows as visible to all, the safe overstatement; the test blocks it.
                  const audience = audienceOf(f.path) ?? 'scoped'
                  return (
                    <Tr key={f.path}>
                      <Td>
                        <code
                          className="font-mono text-xs text-ink"
                          style={{ paddingLeft: `${f.depth}rem` }}
                        >
                          {f.path.split('.').pop()}
                        </code>
                      </Td>
                      <Td className="text-ink-2">{f.description}</Td>
                      {f.group && !(f.path in AUDIENCE) ? (
                        <td colSpan={3} className="px-4 py-3 text-sm text-ink-3">
                          See the fields below
                        </td>
                      ) : audience === 'none' ? (
                        <td colSpan={3} className="px-4 py-3 text-sm text-ink-3">
                          Stored, not shown
                        </td>
                      ) : (
                        SEES[audience].map((yes, i) => <Cell key={i} yes={yes} />)
                      )}
                    </Tr>
                  )
                })}
              </tbody>
            </table>
          </TableFrame>
        </section>
      ))}
    </div>
  )
}
