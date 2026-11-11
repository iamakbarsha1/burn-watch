import { redirect } from 'next/navigation'
import { fetchActivity } from '@/lib/api'
import { formatRange, resolveRange } from '@/lib/format'
import type { RangeParams } from '@/lib/format'
import { getOrgId } from '@/lib/session'
import { PageHeader, Section, EmptyState } from '@/components/ui'

/**
 * These three are categories of activity, not agents, so they take their own
 * hues rather than borrowing a series colour and pretending to be one.
 */
const CATEGORIES = [
  { id: 'tool', label: 'Tools', color: '#7c3aed' },
  { id: 'shell', label: 'Shell commands', color: '#3987e5' },
  { id: 'mcp', label: 'MCP servers', color: '#199e70' },
] as const

function UsageBars({
  color,
  items,
}: {
  color: string
  items: { tool: string; count: number }[]
}) {
  if (items.length === 0) {
    return <p className="text-sm text-ink-3">Nothing recorded in this range</p>
  }
  const max = items[0]?.count ?? 1

  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.tool} className="group">
          <div className="flex items-baseline justify-between gap-4">
            <span className="truncate font-mono text-xs text-ink">{item.tool}</span>
            <span className="shrink-0 text-xs tabular-nums text-ink-2">
              {item.count.toLocaleString()}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-0">
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${(item.count / max) * 100}%`, background: color }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<RangeParams>
}) {
  const { from, to } = resolveRange(await searchParams)

  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  const items = await fetchActivity(from, to, orgId)

  const total = items.reduce((s, i) => s + i.count, 0)

  return (
    <div>
      <PageHeader
        title="Activity Breakdown"
        subtitle={`${formatRange(from, to)} · tool and shell usage from Claude enrichment`}
      />

      {items.length === 0 ? (
        <EmptyState
          title="No activity data"
          message="Tool and shell breakdowns come from Claude Code enrichment. Run an agent sync to populate them."
        />
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-ink-2">
            <span className="font-semibold tabular-nums text-ink">
              {total.toLocaleString()}
            </span>{' '}
            calls across{' '}
            <span className="font-semibold tabular-nums text-ink">{items.length}</span>{' '}
            distinct tools and commands
          </p>

          <div className="grid gap-4 lg:grid-cols-3">
            {CATEGORIES.map((cat) => (
              <Section key={cat.id} title={cat.label}>
                <UsageBars
                  color={cat.color}
                  items={items
                    .filter((i) => i.category === cat.id)
                    .sort((a, b) => b.count - a.count)}
                />
              </Section>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
