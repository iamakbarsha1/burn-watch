import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { fetchTrends, fetchTeams, fetchTeamCompare } from '@/lib/api'
import { BurnAreaChart, AgentSparklines } from '@/components/charts/BurnAreaChart'
import { TeamLinesChart } from '@/components/charts/TeamCharts'
import { TeamFilter } from '@/components/TeamFilter'
import { formatRange, resolveRange } from '@/lib/format'
import type { RangeParams } from '@/lib/format'
import { pickTeam } from '@/lib/teams'
import { getOrgId } from '@/lib/session'
import { PageHeader, Card, EmptyState } from '@/components/ui'

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<RangeParams & { teamId?: string }>
}) {
  const params = await searchParams
  const { from, to } = resolveRange(params)

  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  // A developer gets [], and a failed read hides the team UI rather than the page.
  const teams = await fetchTeams().catch(() => [])
  const team = pickTeam(teams, params.teamId)
  const showCompare = !team && teams.length >= 2

  const [trends, comparison] = await Promise.all([
    fetchTrends(from, to, orgId, team?.id),
    showCompare ? fetchTeamCompare(from, to).catch(() => []) : [],
  ])

  return (
    <div>
      <PageHeader
        title="Burn Trends"
        subtitle={`${formatRange(from, to)} · daily value by agent${team ? ` · team ${team.name}` : ''}`}
      />

      {teams.length > 0 && (
        <Suspense fallback={null}>
          <TeamFilter teams={teams} value={team?.id} />
        </Suspense>
      )}

      {trends.length > 0 ? (
        <div className="space-y-6">
          <Card className="p-4 sm:p-6">
            <BurnAreaChart data={trends} />
          </Card>

          <section>
            <h2 className="mb-3 text-sm font-semibold tracking-tight text-ink">
              Each agent on its own scale
            </h2>
            <AgentSparklines data={trends} />
          </section>

          {comparison.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold tracking-tight text-ink">Daily value by team</h2>
              <p className="mt-1 mb-3 text-sm text-ink-2">
                Someone in two teams counts in both lines.
              </p>
              <Card className="p-4 sm:p-6">
                <TeamLinesChart teams={comparison} />
              </Card>
            </section>
          )}
        </div>
      ) : (
        <EmptyState
          title="No trend data yet"
          message="Nothing was reported in this range. Try widening the dates, or run a sync from a developer machine."
        />
      )}
    </div>
  )
}
