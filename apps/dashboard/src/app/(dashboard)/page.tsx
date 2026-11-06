import { redirect } from 'next/navigation'
import { fetchOverview } from '@/lib/api'
import { AgentBreakdown } from '@/components/charts/AgentBreakdown'
import { formatCost, formatTokens, formatRange, resolveRange } from '@/lib/format'
import type { RangeParams } from '@/lib/format'
import { getOrgId } from '@/lib/session'
import { PageHeader, StatTile, Section, EmptyState } from '@/components/ui'

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<RangeParams>
}) {
  const { from, to } = resolveRange(await searchParams)
  const isRange = from !== to

  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  let overview = null
  try {
    overview = await fetchOverview(from, to, orgId)
  } catch {
    // Show empty state if API unavailable
  }

  return (
    <div>
      <PageHeader title="Overview" subtitle={`${formatRange(from, to)} · all agents`} />

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
