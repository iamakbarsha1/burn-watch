import { fetchActivity } from '@/lib/api'
import { formatCost } from '@/lib/format'

export default async function ActivityPage() {
  const today = new Date().toISOString().slice(0, 10)
  const orgId = process.env.DEMO_ORG_ID ?? 'demo'
  let activities: Awaited<ReturnType<typeof fetchActivity>> = []
  try {
    activities = await fetchActivity(today, orgId)
  } catch {
    // Show empty state if API unavailable
  }

  // Sort by totalCost descending
  activities.sort((a, b) => b.totalCost - a.totalCost)

  return (
    <div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Activity Breakdown</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>Where is AI spend going? (Claude enrichment data)</p>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.5rem' }}>
        {activities.length === 0 ? (
          <p style={{ color: 'var(--muted)', textAlign: 'center', padding: '2rem' }}>No activity data. Requires codeburn enrichment.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {activities.map((act) => {
              const maxCost = activities[0]?.totalCost ?? 1
              const pct = (act.totalCost / maxCost) * 100
              return (
                <div key={act.type}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                    <span style={{ fontWeight: 500 }}>{act.type}</span>
                    <span style={{ color: '#d97706', fontWeight: 600 }}>{formatCost(act.totalCost)}</span>
                  </div>
                  <div style={{ height: '8px', background: 'var(--border)', borderRadius: '4px' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: '#7c3aed', borderRadius: '4px' }} />
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.25rem' }}>
                    {act.totalTurns} turns · {act.userCount} user{act.userCount !== 1 ? 's' : ''}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
