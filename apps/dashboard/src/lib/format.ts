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

/** "$100.00 · 100.0M tokens": what was spent and how much was burned for it. */
export function formatSpend(usd: number, tokens: number): string {
  return `${formatCost(usd)} · ${formatTokens(tokens)} tokens`
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

function daysAgo(n: number, now: Date): string {
  const d = new Date(now)
  d.setDate(d.getDate() - n)
  return today(d)
}

const oneDay = (n: number, now: Date) => ({ from: daysAgo(n, now), to: daysAgo(n, now) })
const lastDays = (n: number, now: Date) => ({ from: daysAgo(n - 1, now), to: today(now) })

/**
 * Every preset, and the only place one is turned into dates.
 *
 * `resolveRange` and `rangePresets` both read this, so a preset is a row here
 * instead of a branch in each of them. The dates sit behind `resolve` rather
 * than in the row because they depend on when you ask: the URL carries only
 * the token, and the window is worked out again on every render.
 */
const RANGE_PRESETS = [
  { token: 'today', label: 'Today', resolve: (now: Date) => oneDay(0, now) },
  { token: 'yesterday', label: 'Yesterday', resolve: (now: Date) => oneDay(1, now) },
  { token: '7d', label: 'Last 7 days', resolve: (now: Date) => lastDays(7, now) },
  { token: '30d', label: 'Last 30 days', resolve: (now: Date) => lastDays(30, now) },
  {
    token: 'all',
    label: 'All time',
    resolve: (now: Date) => ({ from: ALL_TIME_FROM, to: today(now) }),
  },
] as const

export type RangeToken = (typeof RANGE_PRESETS)[number]['token']

/** What every page reads off the URL. `range` is a token, `from`/`to` are dates. */
export interface RangeParams {
  from?: string
  to?: string
  range?: string
}

/**
 * The one place a page turns a URL into a real range.
 *
 * Every page used to do this itself, and they disagreed: four defaulted to
 * today and Trends defaulted to the last 30 days, so the same link told you
 * two different stories depending on which tab you were on. They also lost the
 * range entirely on a nav, because the sidebar links carried no query string.
 * The sidebar now forwards the current params and every page resolves them
 * here, so one answer holds across the whole dashboard.
 *
 * Two dialects, never both in one URL. A preset click writes `?range=<token>`
 * and the window is computed here on each render, so a bookmarked "Last 7
 * days" still means the last seven days next week. Hand-picked dates write
 * `?from&to` and stay where they were put, which is the point of picking them.
 *
 * The default is all time. A dashboard that opens on "today" opens empty most
 * mornings, since the agent uploads yesterday on a 6 PM schedule.
 */
export function resolveRange(
  params: RangeParams,
  now: Date = new Date(),
): { from: string; to: string } {
  // An unrecognised token is a typo or a link from a build that spelled it
  // differently. Falling through beats throwing a whole page away over it.
  const preset = RANGE_PRESETS.find((p) => p.token === params.range)
  if (preset) return preset.resolve(now)

  const from = params.from ?? ALL_TIME_FROM
  const to = params.to ?? today(now)
  // A hand-edited URL is the only way these come in backwards, but the API
  // answers an inverted range with an empty set, which reads as "no data" and
  // sends the reader hunting for a sync problem that isn't there.
  return from > to ? { from: to, to: from } : { from, to }
}

export interface RangePreset {
  label: string
  token: RangeToken
  active: boolean
}

/**
 * The preset buttons, and which one the current URL is sitting on.
 *
 * Active state is token equality. Comparing dates is what broke this twice: a
 * click wrote that day's dates into the URL, and the next morning the
 * arithmetic had moved on while the bookmark had not, so the button went dark
 * and the window quietly stopped following the clock.
 *
 * A URL carrying `from`/`to` lights nothing, including the legacy
 * `?from=2020-01-01` bookmarks that used to light All time. Those still show
 * all-time data; they are a pinned range now, and no button pretends otherwise.
 *
 * No clock here, unlike `resolveRange`. Which button is lit depends only on
 * what the URL says, which is the whole point of putting a token in it.
 */
export function rangePresets(params: RangeParams): RangePreset[] {
  const pinned = params.from !== undefined || params.to !== undefined
  const activeToken = params.range ?? (pinned ? null : 'all')

  return RANGE_PRESETS.map((p) => ({
    label: p.label,
    token: p.token,
    active: p.token === activeToken,
  }))
}
