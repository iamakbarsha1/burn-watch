import { fetchTrends } from '@/lib/api'
import { BurnAreaChart } from '@/components/charts/BurnAreaChart'

export default async function TrendsPage() {
  const orgId = process.env.DEMO_ORG_ID ?? 'demo'
  let trends: Awaited<ReturnType<typeof fetchTrends>> = []
  try {
    trends = await fetchTrends(30, orgId)
  } catch {
    // Show empty state if API unavailable
  }

  return (
    <div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Burn Trends</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>Last 30 days · Daily AI spend by agent</p>

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
