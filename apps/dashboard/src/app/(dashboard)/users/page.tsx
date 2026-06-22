import { redirect } from 'next/navigation'
import { fetchLeaderboard } from '@/lib/api'
import { formatCost, formatTokens } from '@/lib/format'
import { getOrgId } from '@/lib/session'

export default async function LeaderboardPage() {
  const today = new Date().toISOString().slice(0, 10)
  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  let users: Awaited<ReturnType<typeof fetchLeaderboard>> = []
  try {
    users = await fetchLeaderboard(today, orgId)
  } catch {
    // Show empty state if API unavailable
  }

  return (
    <div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Developer Leaderboard</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>{today} · Ranked by AI spend</p>

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
