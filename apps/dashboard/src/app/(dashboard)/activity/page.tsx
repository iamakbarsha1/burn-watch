import { redirect } from 'next/navigation'
import { fetchActivity } from '@/lib/api'
import { DateRangePicker } from '@/components/DateRangePicker'
import { getOrgId } from '@/lib/session'

const CATEGORY_COLORS: Record<string, string> = {
  tool: '#7c3aed',
  shell: '#0891b2',
  mcp: '#059669',
}

const CATEGORY_LABELS: Record<string, string> = {
  tool: 'Tools',
  shell: 'Shell Commands',
  mcp: 'MCP Servers',
}

function UsageSection({ title, color, items }: {
  title: string
  color: string
  items: { tool: string; count: number }[]
}) {
  if (items.length === 0) return null
  const max = items[0]?.count ?? 1
  return (
    <div>
      <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', color }}>{title}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {items.map((item) => {
          const pct = (item.count / max) * 100
          return (
            <div key={item.tool}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                <span style={{ fontWeight: 500, fontFamily: 'monospace', fontSize: '0.875rem' }}>{item.tool}</span>
                <span style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>{item.count.toLocaleString()}</span>
              </div>
              <div style={{ height: '6px', background: 'var(--border)', borderRadius: '3px' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '3px' }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const params = await searchParams
  const today = new Date().toISOString().slice(0, 10)
  const from = params.from ?? today
  const to = params.to ?? today

  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  let items: Awaited<ReturnType<typeof fetchActivity>> = []
  try {
    items = await fetchActivity(from, to, orgId)
  } catch {
    // Show empty state if API unavailable
  }

  const byCategory = {
    tool: items.filter(i => i.category === 'tool').sort((a, b) => b.count - a.count),
    shell: items.filter(i => i.category === 'shell').sort((a, b) => b.count - a.count),
    mcp: items.filter(i => i.category === 'mcp').sort((a, b) => b.count - a.count),
  }

  const subtitle = from === to ? from : `${from} — ${to}`
  const total = items.reduce((s, i) => s + i.count, 0)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Activity Breakdown</h1>
          <p style={{ color: 'var(--muted)' }}>Tool &amp; shell usage from Claude enrichment · {subtitle}</p>
        </div>
        <DateRangePicker />
      </div>

      {items.length === 0 ? (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.5rem' }}>
          <p style={{ color: 'var(--muted)', textAlign: 'center', padding: '2rem' }}>No activity data. Run agent sync to populate.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          <p style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>{total.toLocaleString()} total calls across {items.length} distinct tools/commands</p>
          {(['tool', 'shell', 'mcp'] as const).map((cat) => (
            <div key={cat} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.5rem' }}>
              <UsageSection
                title={CATEGORY_LABELS[cat]}
                color={CATEGORY_COLORS[cat]}
                items={byCategory[cat]}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
