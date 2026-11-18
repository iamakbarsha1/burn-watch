import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { fetchOverview, fetchTeams, fetchTeamCompare } from '@/lib/api'
import { AgentBreakdown } from '@/components/charts/AgentBreakdown'
import { TeamFilter } from '@/components/TeamFilter'
import { formatCost, formatTokens, formatRange, resolveRange } from '@/lib/format'
import type { RangeParams } from '@/lib/format'
import { pickTeam } from '@/lib/teams'
import { getOrgId } from '@/lib/session'
import { PageHeader, StatTile, Section, EmptyState, TableFrame, Th, Td, Tr } from '@/components/ui'

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<RangeParams & { teamId?: string }>
}) {
  const params = await searchParams
  const { from, to } = resolveRange(params)
  const isRange = from !== to

  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  // A developer gets [], and a failed read hides the team UI rather than the page.
  const teams = await fetchTeams().catch(() => [])
  const team = pickTeam(teams, params.teamId)
  const showCompare = !team && teams.length >= 2

  const [overview, comparison] = await Promise.all([
    fetchOverview(from, to, orgId, team?.id),
    showCompare ? fetchTeamCompare(from, to).catch(() => []) : [],
  ])

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle={`${formatRange(from, to)} · ${team ? `team ${team.name}` : 'all agents'}`}
      />

      {teams.length > 0 && (
        <Suspense fallback={null}>
          <TeamFilter teams={teams} value={team?.id} />
        </Suspense>
      )}

      {overview ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              label={isRange ? 'Total spend' : 'Spend today'}
              value={formatCost(overview.totalCostUsd)}
              delta={!isRange ? overview.vsYesterday.costPct : undefined}
            />
            <StatTile label="Total tokens" value={formatTokens(overview.totalTokens)} />
            <StatTile label="Active developers" value={String(overview.activeUsers)} />
          </div>

          <Section title="By agent">
            <AgentBreakdown agents={overview.byAgent} />
          </Section>

          {comparison.length > 0 && (
            <Section
              title="Teams"
              description="Someone in two teams counts in both, so these can add up to more than the total above."
            >
              <TableFrame>
                <table className="w-full min-w-[520px] border-collapse">
                  <thead className="bg-surface-2">
                    <tr>
                      <Th>Team</Th>
                      <Th numeric>Active / members</Th>
                      <Th numeric>Tokens</Th>
                      <Th numeric>Spend</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...comparison]
                      .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
                      .map((t) => (
                        <Tr key={t.teamId}>
                          <Td className="font-medium text-ink">{t.name}</Td>
                          <Td numeric className="text-ink-2">
                            {t.activeUsers} / {t.memberCount}
                          </Td>
                          <Td numeric className="text-ink-2">
                            {formatTokens(t.totalTokens)}
                          </Td>
                          <Td numeric className="font-semibold text-ink">
                            {formatCost(t.totalCostUsd)}
                          </Td>
                        </Tr>
                      ))}
                  </tbody>
                </table>
              </TableFrame>
            </Section>
          )}
        </div>
      ) : (
        <EmptyState
          title="No data yet"
          message="Nothing has been reported for this range. Check that developers have installed the BurnWatch agent, or widen the date range."
        />
      )}
    </div>
  )
}
