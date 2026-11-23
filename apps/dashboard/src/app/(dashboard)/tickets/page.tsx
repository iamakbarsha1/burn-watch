import { redirect } from 'next/navigation'
import { fetchTickets } from '@/lib/api'
import { formatCost, formatCount, formatRange, resolveRange } from '@/lib/format'
import type { RangeParams } from '@/lib/format'
import { getOrgId, getUserRole } from '@/lib/session'
import { PageHeader, Section, TableFrame, Th, Td, Tr, EmptyRow } from '@/components/ui'
import { TicketSettingsForm } from './TicketSettingsForm'

const TOP = 50

/** R2 C4. Claude Code value per Jira ticket, read from branch names. */
export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<RangeParams & { all?: string }>
}) {
  const params = await searchParams
  const { from, to } = resolveRange(params)
  if (!(await getOrgId())) redirect('/login')
  const isAdmin = (await getUserRole()) === 'admin'
  const data = await fetchTickets(from, to).catch(() => null)

  const showAll = params.all === '1'
  const tickets = data ? (showAll ? data.tickets : data.tickets.slice(0, TOP)) : []
  const allHref = `?${new URLSearchParams({ ...(params.from && { from: params.from }), ...(params.to && { to: params.to }), ...(params.range && { range: params.range }), all: '1' })}`

  return (
    <div>
      <PageHeader title="Tickets" subtitle={`${formatRange(from, to)} · API-equivalent value per Jira ticket`} />

      {data === null ? (
        <p className="text-sm text-bad">Could not read ticket usage. Try again in a moment.</p>
      ) : (
        <>
          {data.prefixes === null && (
            <p className="mb-4 text-sm text-ink-2">
              {isAdmin
                ? 'Set your Jira project keys below to see usage per ticket.'
                : 'Your admin has not set Jira project keys yet, so no tickets are counted.'}
            </p>
          )}

          {data.prefixes !== null && (
            <>
              <Section title="Per ticket">
                <TableFrame>
                  <table className="w-full">
                    <thead>
                      <tr>
                        <Th>Ticket</Th>
                        <Th numeric>Value</Th>
                        <Th numeric>Sessions</Th>
                        <Th numeric>Users</Th>
                        <Th numeric>Repos</Th>
                        <Th numeric>Days</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {tickets.length === 0 ? (
                        <EmptyRow colSpan={6}>No ticket branches in this range.</EmptyRow>
                      ) : (
                        tickets.map((t) => (
                          <Tr key={t.key}>
                            <Td className="font-mono text-sm text-ink">{t.key}</Td>
                            <Td numeric className="font-semibold text-ink">{formatCost(t.cost)}</Td>
                            <Td numeric className="text-ink-2">{formatCount(t.sessions)}</Td>
                            <Td numeric className="text-ink-2">{t.userCount}</Td>
                            <Td numeric className="text-ink-2">{t.repoCount}</Td>
                            <Td numeric className="text-ink-2">{t.days}</Td>
                          </Tr>
                        ))
                      )}
                      <Tr>
                        <Td className="text-ink-2">No ticket</Td>
                        <Td numeric className="text-ink-2">{formatCost(data.noTicket.cost)}</Td>
                        <Td numeric className="text-ink-2">{formatCount(data.noTicket.sessions)}</Td>
                        <Td numeric>{''}</Td>
                        <Td numeric>{''}</Td>
                        <Td numeric>{''}</Td>
                      </Tr>
                    </tbody>
                  </table>
                </TableFrame>
                {!showAll && data.tickets.length > TOP && (
                  <a href={allHref} className="mt-3 inline-block text-sm underline">
                    Show all {data.tickets.length} tickets
                  </a>
                )}
              </Section>

              <Section title="Per project key">
                <TableFrame>
                  <table className="w-full">
                    <thead>
                      <tr>
                        <Th>Key</Th>
                        <Th numeric>Tickets</Th>
                        <Th numeric>Value</Th>
                        <Th numeric>Sessions</Th>
                        <Th numeric>Users</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.projectKeys.length === 0 ? (
                        <EmptyRow colSpan={5}>No ticket branches in this range.</EmptyRow>
                      ) : (
                        data.projectKeys.map((p) => (
                          <Tr key={p.prefix}>
                            <Td className="font-mono text-sm text-ink">{p.prefix}</Td>
                            <Td numeric>{p.tickets}</Td>
                            <Td numeric className="font-semibold text-ink">{formatCost(p.cost)}</Td>
                            <Td numeric className="text-ink-2">{formatCount(p.sessions)}</Td>
                            <Td numeric className="text-ink-2">{p.userCount}</Td>
                          </Tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </TableFrame>
              </Section>
            </>
          )}

          {isAdmin && (
            <Section title="Project keys" description="Only branches with one of these keys count as tickets, so names like UTF-8 are never mistaken for one.">
              <TicketSettingsForm
                prefixes={data.prefixes ?? []}
                suggestions={(data.suggestions ?? []).map((s) => s.prefix)}
              />
            </Section>
          )}

          <p className="mt-4 text-xs text-ink-2">
            Claude Code only, from branch names. Agent 0.4 or later. A session on two days or two branches counts in
            each, and only the top 50 branches per project per day are sent.
          </p>
        </>
      )}
    </div>
  )
}
