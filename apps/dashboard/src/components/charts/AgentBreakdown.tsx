import type { AgentSummary } from '@burn-watch/shared'
import { formatCost, formatTokens } from '@/lib/format'
import { agentById } from '@/lib/agents'
import { SeriesDot } from '@/components/ui'

export function AgentBreakdown({ agents }: { agents: AgentSummary[] }) {
  if (agents.length === 0) {
    return <p className="py-8 text-center text-sm text-ink-2">No agent data</p>
  }

  // Biggest spender first — the reader is looking for where the money went.
  const sorted = [...agents].sort((a, b) => b.costUsd - a.costUsd)
  const maxCost = Math.max(...sorted.map((a) => a.costUsd), 0)

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {sorted.map((a) => {
        const cfg = agentById(a.agent)
        const color = cfg?.color ?? '#6f6f6f'
        const label = cfg?.label ?? a.agent
        const share = maxCost > 0 ? (a.costUsd / maxCost) * 100 : 0
        return (
          <div
            key={a.agent}
            className="rounded-[var(--radius-card)] border border-line bg-surface-2 p-4 transition-colors hover:border-line-strong"
          >
            <div className="flex items-center gap-2">
              <SeriesDot color={color} />
              <span className="text-xs text-ink-2">{label}</span>
              {a.isFreeTier && (
                <span className="ml-auto rounded-full border border-line-strong px-1.5 py-px text-[10px] text-ink-3">
                  free tier
                </span>
              )}
            </div>

            <p className="mt-2 text-2xl leading-none font-semibold text-ink">
              {a.isFreeTier ? formatTokens(a.tokens) : formatCost(a.costUsd)}
            </p>

            <p className="mt-1.5 text-xs text-ink-3">
              {a.isFreeTier ? 'tokens · no billable cost' : `${formatTokens(a.tokens)} tokens`}
            </p>

            {/* The bar repeats the number as length, so the tiles can be
                compared without reading every figure. */}
            {!a.isFreeTier && (
              <div
                className="mt-3 h-1 overflow-hidden rounded-full bg-surface-0"
                role="presentation"
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${share}%`, background: color }}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
