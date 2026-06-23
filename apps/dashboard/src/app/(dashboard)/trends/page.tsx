import { redirect } from 'next/navigation'
import { fetchTrends } from '@/lib/api'
import { BurnAreaChart } from '@/components/charts/BurnAreaChart'
import { DateRangePicker } from '@/components/DateRangePicker'
import { getOrgId } from '@/lib/session'

export default async function TrendsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const params = await searchParams
  const today = new Date().toISOString().slice(0, 10)
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29)
  const defaultFrom = thirtyDaysAgo.toISOString().slice(0, 10)

  const from = params.from ?? defaultFrom
  const to = params.to ?? today

  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  let trends: Awaited<ReturnType<typeof fetchTrends>> = []
  try {
    trends = await fetchTrends(from, to, orgId)
  } catch {
    // Show empty state if API unavailable
  }

  const subtitle = `${from} — ${to} · Daily AI spend by agent`

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Burn Trends</h1>
          <p style={{ color: 'var(--muted)' }}>{subtitle}</p>
        </div>
        <DateRangePicker />
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.5rem' }}>
        {trends.length > 0 ? (
          <BurnAreaChart data={trends} />
        ) : (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--muted)' }}>No trend data yet</div>
        )}
      </div>
    </div>
  )
}
