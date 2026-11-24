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

const SEES: Record<Audience, [boolean, boolean, boolean]> = {
  scoped: [true, true, true],
  self: [true, false, false],
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
        subtitle="Every field the agent on your laptop can send, and who can see it. This list is built from the schema the server checks every upload against."
      />

      <Section title="Never collected">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          {NEVER.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Section>

      <p className="text-sm text-ink-2">
        <strong className="text-ink">Your manager</strong> means a manager of a team you are in.
        Fields marked <em>stored, not shown</em> are kept but no page or API route returns them
        yet. Admins with database access can still read them.
      </p>

      <p className="text-sm text-ink-2">
        Admins can see a log of who opened views that include team or person data.
      </p>

      <p className="text-sm text-ink-2">
        Totals for a team, or for the teams a manager runs, are hidden when they cover fewer than{' '}
        {MIN_GROUP_SIZE} people. A small team cannot be used to read one person&apos;s numbers.
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
