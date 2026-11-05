import { redirect } from 'next/navigation'
import { fetchTrends } from '@/lib/api'
import { BurnAreaChart, AgentSparklines } from '@/components/charts/BurnAreaChart'
import { formatRange, resolveRange } from '@/lib/format'
import { getOrgId } from '@/lib/session'
import { PageHeader, Card, EmptyState } from '@/components/ui'

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const { from, to } = resolveRange(await searchParams)

  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  let trends: Awaited<ReturnType<typeof fetchTrends>> = []
  try {
    trends = await fetchTrends(from, to, orgId)
  } catch {
    // Show empty state if API unavailable
  }

  return (
    <div>
      <PageHeader
        title="Burn Trends"
        subtitle={`${formatRange(from, to)} · daily spend by agent`}
      />

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
