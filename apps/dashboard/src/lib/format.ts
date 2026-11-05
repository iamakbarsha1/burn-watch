export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatPct(n: number): string {
  return `${n.toFixed(1)}%`
}

/**
 * "3d ago" for a timestamp, or null when there is nothing to report. An admin
 * scanning the team table reads a gap faster than a date, and the gap is the
 * thing that matters: a machine that stopped syncing a week ago.
 */
export function formatAgo(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const mins = Math.floor((now.getTime() - then) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Lower bound for the "All time" preset. The dashboard APIs return only the
 * dates that have snapshot rows, so a floor far below the first sync costs
 * nothing and saves the client from having to ask when collection started.
 */
export const ALL_TIME_FROM = '2020-01-01'

export function formatRange(from: string, to: string): string {
  if (from <= ALL_TIME_FROM) return 'All time'
  if (from === to) return from
  return `${from} — ${to}`
}
