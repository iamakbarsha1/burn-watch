import { redirect } from 'next/navigation'
import { fetchLeaderboard } from '@/lib/api'
import { formatCost, formatTokens, formatRange, resolveRange, formatCount } from '@/lib/format'
import type { RangeParams } from '@/lib/format'
import { getOrgId } from '@/lib/session'
import { agentById } from '@/lib/agents'
import { PageHeader, TableFrame, Th, Td, Tr, EmptyRow, SeriesDot } from '@/components/ui'

const CLAUDE = agentById('claude')!
const QWEN = agentById('qwen')!
const COPILOT = agentById('copilot')!

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<RangeParams>
}) {
  const { from, to } = resolveRange(await searchParams)

  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  let users: Awaited<ReturnType<typeof fetchLeaderboard>> = []
  try {
    users = await fetchLeaderboard(from, to, orgId)
  } catch {
    // Show empty state if API unavailable
  }

  return (
    <div>
      <PageHeader
        title="Developer Leaderboard"
        subtitle={`${formatRange(from, to)} · ranked by AI spend`}
      />

      <TableFrame>
        <table className="w-full border-collapse">
          <thead className="bg-surface-2">
            <tr>
              <Th>#</Th>
              <Th>Developer</Th>
              <Th numeric>
                <span className="inline-flex items-center gap-1.5">
                  <SeriesDot color={CLAUDE.color} /> Claude
                </span>
              </Th>
              <Th numeric>
                <span className="inline-flex items-center gap-1.5">
                  <SeriesDot color={QWEN.color} /> Qwen tokens
                </span>
              </Th>
              <Th numeric>
                <span className="inline-flex items-center gap-1.5">
                  <SeriesDot color={COPILOT.color} /> Copilot
                </span>
              </Th>
              <Th numeric>Total</Th>
              <Th numeric>Sessions</Th>
              <Th numeric>Cache hit</Th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <EmptyRow colSpan={8}>No data for this range</EmptyRow>
            )}
            {users.map((u, i) => (
              <Tr key={u.userId}>
                <Td className="text-ink-3">{i + 1}</Td>
                <Td>
                  <div className="font-medium text-ink">{u.name}</div>
                  <div className="text-xs text-ink-3">{u.email}</div>
                </Td>
                <Td numeric className="font-medium text-ink">
                  {formatCost(u.claude.costUsd)}
                </Td>
                <Td numeric className="text-ink-2">
                  {formatTokens(u.qwen.tokens)}
                </Td>
                <Td numeric className="text-ink-2">
                  {formatCost(u.copilot.costUsd)}
                </Td>
                <Td numeric className="font-semibold text-ink">
                  {formatCost(u.totalCostUsd)}
                </Td>
                <Td numeric className="text-ink-2">
                  {formatCount(u.sessions)}
                </Td>
                <Td
                  numeric
                  className={
                    u.cacheHitRate !== null && u.cacheHitRate > 80 ? 'text-good' : 'text-ink-2'
                  }
                >
                  {u.cacheHitRate !== null ? `${u.cacheHitRate.toFixed(1)}%` : '—'}
                </Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </div>
  )
}
