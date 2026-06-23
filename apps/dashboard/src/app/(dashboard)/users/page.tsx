import { redirect } from 'next/navigation'
import { fetchLeaderboard } from '@/lib/api'
import { DateRangePicker } from '@/components/DateRangePicker'
import { formatCost, formatTokens } from '@/lib/format'
import { getOrgId } from '@/lib/session'

export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const params = await searchParams
  const today = new Date().toISOString().slice(0, 10)
  const from = params.from ?? today
  const to = params.to ?? today

  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  let users: Awaited<ReturnType<typeof fetchLeaderboard>> = []
  try {
    users = await fetchLeaderboard(from, to, orgId)
  } catch {
    // Show empty state if API unavailable
  }

  const subtitle = from === to ? `${from} · Ranked by AI spend` : `${from} — ${to} · Ranked by AI spend`

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Developer Leaderboard</h1>
          <p style={{ color: 'var(--muted)' }}>{subtitle}</p>
        </div>
        <DateRangePicker />
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Rank', 'Developer', 'Claude', 'Qwen Tokens', 'Copilot', 'Total', 'Sessions', 'Cache Hit'].map((h) => (
                <th key={h} style={{ padding: '1rem', textAlign: 'left', fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>No data yet</td>
              </tr>
            )}
            {users.map((u, i) => (
              <tr key={u.userId} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '1rem', color: 'var(--muted)', fontSize: '0.85rem' }}>#{i + 1}</td>
                <td style={{ padding: '1rem' }}>
                  <div style={{ fontWeight: 500 }}>{u.name}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{u.email}</div>
                </td>
                <td style={{ padding: '1rem', color: '#d97706', fontWeight: 600 }}>{formatCost(u.claude.costUsd)}</td>
                <td style={{ padding: '1rem', color: '#06b6d4' }}>{formatTokens(u.qwen.tokens)}</td>
                <td style={{ padding: '1rem', color: '#6366f1' }}>{formatCost(u.copilot.costUsd)}</td>
                <td style={{ padding: '1rem', fontWeight: 700 }}>{formatCost(u.totalCostUsd)}</td>
                <td style={{ padding: '1rem', color: 'var(--muted)' }}>{u.sessions}</td>
                <td style={{ padding: '1rem', color: u.cacheHitRate !== null && u.cacheHitRate > 80 ? 'var(--success)' : 'var(--muted)' }}>
                  {u.cacheHitRate !== null ? `${u.cacheHitRate.toFixed(1)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
