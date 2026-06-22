import { redirect } from 'next/navigation'
import { fetchOverview } from '@/lib/api'
import { AgentBreakdown } from '@/components/charts/AgentBreakdown'
import { formatCost, formatTokens } from '@/lib/format'
import { getOrgId } from '@/lib/session'

export default async function OverviewPage() {
  const today = new Date().toISOString().slice(0, 10)
  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  let overview = null
  try {
    overview = await fetchOverview(today, orgId)
  } catch {
    // Show empty state if API unavailable
  }

  return (
    <div>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Overview</h1>
        <p style={{ color: 'var(--muted)' }}>{today}</p>
      </div>

      {overview ? (
        <>
          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
            <StatCard label="Total Spend Today" value={formatCost(overview.totalCostUsd)} delta={overview.vsYesterday.costPct} />
            <StatCard label="Total Tokens" value={formatTokens(overview.totalTokens)} />
            <StatCard label="Active Users" value={String(overview.activeUsers)} />
          </div>

          {/* Agent breakdown */}
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.5rem' }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>By Agent</h2>
            <AgentBreakdown agents={overview.byAgent} />
          </div>
        </>
      ) : (
        <EmptyState message="No data yet. Make sure developers have installed the BurnWatch agent." />
      )}
    </div>
  )
}

function StatCard({ label, value, delta }: { label: string; value: string; delta?: number }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.5rem' }}>
      <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{label}</p>
      <p style={{ fontSize: '1.75rem', fontWeight: 700 }}>{value}</p>
      {delta !== undefined && (
        <p style={{ fontSize: '0.8rem', color: delta >= 0 ? 'var(--warning)' : 'var(--success)', marginTop: '0.25rem' }}>
          {delta >= 0 ? '+' : ''}{delta.toFixed(1)}% vs yesterday
        </p>
      )}
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '3rem', textAlign: 'center' }}>
      <p style={{ color: 'var(--muted)' }}>{message}</p>
    </div>
  )
}
