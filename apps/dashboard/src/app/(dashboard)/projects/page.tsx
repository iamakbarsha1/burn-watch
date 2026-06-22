import { redirect } from 'next/navigation'
import { fetchProjects } from '@/lib/api'
import { formatCost } from '@/lib/format'
import { getOrgId } from '@/lib/session'

export default async function ProjectsPage() {
  const today = new Date().toISOString().slice(0, 10)
  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  let projects: Awaited<ReturnType<typeof fetchProjects>> = []
  try {
    projects = await fetchProjects(today, orgId)
  } catch {
    // Show empty state if API unavailable
  }

  projects.sort((a, b) => b.totalCost - a.totalCost)

  return (
    <div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Project Breakdown</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>AI spend by internal project</p>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Project', 'Total Cost', 'Sessions', 'Avg/Session', 'Users'].map((h) => (
                <th key={h} style={{ padding: '1rem', textAlign: 'left', fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
                  No project data. Requires codeburn enrichment.
                </td>
              </tr>
            )}
            {projects.map((p) => (
              <tr key={p.path} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '1rem', fontFamily: 'monospace', fontSize: '0.875rem' }}>{p.path}</td>
                <td style={{ padding: '1rem', color: '#d97706', fontWeight: 600 }}>{formatCost(p.totalCost)}</td>
                <td style={{ padding: '1rem', color: 'var(--muted)' }}>{p.totalSessions}</td>
                <td style={{ padding: '1rem', color: 'var(--muted)' }}>{formatCost(p.avgCostPerSession)}</td>
                <td style={{ padding: '1rem', color: 'var(--muted)' }}>{p.userCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
