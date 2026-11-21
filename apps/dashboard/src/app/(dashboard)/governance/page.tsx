import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { fetchFreeTier, fetchTeams } from '@/lib/api'
import { agentById } from '@/lib/agents'
import { formatRange, formatTokens, resolveRange } from '@/lib/format'
import type { RangeParams } from '@/lib/format'
import { pickTeam } from '@/lib/teams'
import { getUserRole } from '@/lib/session'
import { TeamFilter } from '@/components/TeamFilter'
import { PageHeader, Section, TableFrame, Th, Td, Tr, EmptyRow, Badge } from '@/components/ui'

// Shown whatever the list holds, so an empty list is never read as "nobody
// uses Gemini's free tier". Remove when BW-43 ships.
const GEMINI_NOTE =
  'Gemini on a personal Google login is free, but it is not detected yet: those rows carry a list-price cost and are not flagged (BW-43).'

export default async function GovernancePage({
  searchParams,
}: {
  searchParams: Promise<RangeParams & { teamId?: string }>
}) {
  const role = await getUserRole()
  if (role !== 'admin' && role !== 'manager') redirect('/')

  const params = await searchParams
  const { from, to } = resolveRange(params)
  const teams = await fetchTeams().catch(() => [])
  const team = pickTeam(teams, params.teamId)
  const data = await fetchFreeTier(from, to, team?.id).catch(() => null)

  return (
    <div>
      <PageHeader
        title="Governance"
        subtitle={`${formatRange(from, to)}${team ? ` · team ${team.name}` : ''}`}
      />

      {teams.length > 0 && (
        <Suspense fallback={null}>
          <TeamFilter teams={teams} value={team?.id} />
        </Suspense>
      )}

      <Section
        title="Free-tier usage"
        description="Free tiers may let the provider train on what is sent to them, including company or client code. Check each provider's terms."
      >
        {data && data.byTeam.length > 0 && (
          <p className="mb-3 text-sm text-ink-2">
            {data.byTeam
              .map(
                (t) =>
                  `${t.teamName ?? 'No team'}: ${t.users} ${t.users === 1 ? 'person' : 'people'}, ${formatTokens(t.tokens)} tokens`,
              )
              .join(' · ')}
          </p>
        )}

        <TableFrame>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Teams</Th>
                <Th>Agent · model</Th>
                <Th>Why flagged</Th>
                <Th numeric>Days</Th>
                <Th numeric>Tokens</Th>
                <Th numeric>Last seen</Th>
              </tr>
            </thead>
            <tbody>
              {data === null ? (
                <EmptyRow colSpan={7}>Could not read free-tier usage. Try again in a moment.</EmptyRow>
              ) : data.rows.length === 0 ? (
                <EmptyRow colSpan={7}>No free-tier usage in this range.</EmptyRow>
              ) : (
                data.rows.map((r) => (
                  <Tr key={`${r.userId}:${r.agent}:${r.modelName}`}>
                    <Td>
                      <div className="font-medium text-ink">{r.userName ?? 'Removed user'}</div>
                      {r.userEmail && <div className="text-xs text-ink-2">{r.userEmail}</div>}
                    </Td>
                    <Td className="text-ink-2">{r.teams.length ? r.teams.join(', ') : '—'}</Td>
                    <Td>
                      {agentById(r.agent)?.label ?? r.agent} · <span className="text-ink-2">{r.modelName}</span>
                    </Td>
                    <Td>
                      {r.reason === 'free-tier-agent' ? (
                        <Badge tone="warn">free-tier agent</Badge>
                      ) : (
                        <Badge>unpriced model</Badge>
                      )}
                    </Td>
                    <Td numeric>{r.days}</Td>
                    <Td numeric>{formatTokens(r.tokens)}</Td>
                    <Td numeric>{r.lastDate}</Td>
                  </Tr>
                ))
              )}
            </tbody>
          </table>
        </TableFrame>
        <p className="mt-3 text-xs text-ink-2">
          &ldquo;Unpriced model&rdquo; means the agent found no price for the model, so it may not
          be a free tier. {GEMINI_NOTE}
        </p>
      </Section>
    </div>
  )
}
