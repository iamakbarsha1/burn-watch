/**
 * Grouped thousands, always. An all-time figure runs to four and five digits,
 * and `$3038.53` makes a reader count characters to find the magnitude.
 */
const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return USD.format(usd)
}

/** Counts in tables and prose — sessions, call counts, day counts. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
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

export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/**
 * The one place a page turns `?from&to` into a real range.
 *
 * Every page used to do this itself, and they disagreed: four defaulted to
 * today and Trends defaulted to the last 30 days, so the same link told you
 * two different stories depending on which tab you were on. They also lost the
 * range entirely on a nav, because the sidebar links carried no query string.
 * The sidebar now forwards the current params and every page resolves them
 * here, so one answer holds across the whole dashboard.
 *
 * The default is all time. A dashboard that opens on "today" opens empty most
 * mornings, since the agent uploads yesterday on a 6 PM schedule.
 */
export function resolveRange(
  params: { from?: string; to?: string },
  now: Date = new Date(),
): { from: string; to: string } {
  const end = today(now)
  const from = params.from ?? ALL_TIME_FROM
  const to = params.to ?? end
  // A hand-edited URL is the only way these come in backwards, but the API
  // answers an inverted range with an empty set, which reads as "no data" and
  // sends the reader hunting for a sync problem that isn't there.
  return from > to ? { from: to, to: from } : { from, to }
}
