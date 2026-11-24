import { Suspense } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { fetchOverview, fetchTeams, fetchTeamCompare, fetchViolationCount } from '@/lib/api'
import { unlessTooSmall } from '@/lib/group-too-small'
import { AgentBreakdown } from '@/components/charts/AgentBreakdown'
import { TeamFilter } from '@/components/TeamFilter'
import { formatCost, formatTokens, formatRange, resolveRange, formatActualCostHint } from '@/lib/format'
import type { RangeParams } from '@/lib/format'
import { pickTeam } from '@/lib/teams'
import { getOrgId, getUserRole } from '@/lib/session'
import { GroupTooSmall, PageHeader, StatTile, Section, EmptyState, TableFrame, Th, Td, Tr } from '@/components/ui'

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

  const isAdmin = (await getUserRole()) === 'admin'
  const loaded = await unlessTooSmall(
    Promise.all([
      fetchOverview(from, to, orgId, team?.id),
      showCompare ? fetchTeamCompare(from, to).catch(() => []) : [],
      // Shares the layout's call through cache(): same request, one fetch.
      isAdmin ? fetchViolationCount().catch(() => 0) : 0,
    ]),
  )
  if (!loaded) {
    return (
      <div>
        <PageHeader title="Overview" subtitle={formatRange(from, to)} />
        {teams.length > 0 && (
          <Suspense fallback={null}>
            <TeamFilter teams={teams} value={team?.id} />
          </Suspense>
        )}
        <GroupTooSmall />
      </div>
    )
  }
  const [overview, comparison, violationCount] = loaded

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle={`${formatRange(from, to)} · ${team ? `team ${team.name}` : 'all agents'}`}
      />

      {violationCount > 0 && (
        <p className="mb-4 rounded-lg border border-bad/35 bg-bad/10 px-4 py-3 text-sm text-bad">
          {violationCount === 1 ? '1 use' : `${violationCount} uses`} of an agent or model outside the policy in the
          last 30 days.{' '}
          <Link href="/governance" className="font-medium underline">
            Review on Governance
          </Link>
        </p>
      )}

      {teams.length > 0 && (
        <Suspense fallback={null}>
          <TeamFilter teams={teams} value={team?.id} />
        </Suspense>
      )}

      {overview ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label={isRange ? 'Value received' : 'Value today'}
              value={formatCost(overview.valueUsd)}
              hint="usage at API list prices"
              delta={!isRange ? overview.vsYesterday.costPct : undefined}
            />
            <StatTile
              label="Actual cost"
              value={formatCost(overview.actualCost.totalUsd)}
              hint={formatActualCostHint(
                overview.actualCost.seatCount,
                overview.actualCost.monthlySeatUsd,
                overview.actualCost.apiUsd,
              )}
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
                      <Th numeric>Value</Th>
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
