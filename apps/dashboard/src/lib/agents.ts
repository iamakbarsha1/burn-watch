import type { TrendPoint } from '@burn-watch/shared'

/**
 * Agent identity: one hue each, fixed, never assigned by rank.
 *
 * These are the dark steps of the dataviz reference palette, re-ordered so
 * Claude keeps the orange it has always worn, then re-validated as a set
 * against the card the charts render on (#111111) — lightness band, chroma
 * floor, CVD separation, normal-vision separation and contrast all pass.
 * Editing a hex here means re-running that check.
 *
 * `costKey` is the field on TrendPoint, which is also the Recharts dataKey.
 */
export const AGENTS = [
  { id: 'claude', label: 'Claude', color: '#d95926', costKey: 'claudeCost' },
  { id: 'copilot', label: 'Copilot', color: '#3987e5', costKey: 'copilotCost' },
  { id: 'codex', label: 'Codex', color: '#199e70', costKey: 'codexCost' },
  { id: 'gemini', label: 'Gemini', color: '#c98500', costKey: 'geminiCost' },
  { id: 'qwen', label: 'Qwen', color: '#d55181', costKey: 'qwenCost' },
] as const satisfies readonly {
  id: string
  label: string
  color: string
  costKey: keyof TrendPoint
}[]

export type Agent = (typeof AGENTS)[number]

export function agentById(id: string): Agent | undefined {
  return AGENTS.find((a) => a.id === id)
}

const DAY_MS = 86_400_000

function toUtc(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

const ZERO = {
  claudeCost: 0,
  qwenCost: 0,
  geminiCost: 0,
  codexCost: 0,
  copilotCost: 0,
  totalCost: 0,
  claudeTokens: 0,
  qwenTokens: 0,
  totalTokens: 0,
} as const

/**
 * Insert a zero row for every calendar day the API skipped.
 *
 * The trends endpoint groups by date, so it returns only days that have
 * snapshot rows. Recharts treats the x-axis as evenly spaced categories, which
 * means a six-month gap between two rows renders exactly as wide as one day —
 * the all-time chart showed March sitting next to October with no visual hint
 * that nothing happened in between. Filling the gaps makes the axis real time
 * again, and quiet stretches read as flat, which is the truth.
 *
 * The span is taken from the data, not from the requested range: "All time"
 * asks the API from 2020-01-01, and honouring that literally would prepend six
 * years of zeroes to a chart that starts in March.
 *
 * ponytail: linear fill, one point per day. ~230 points today and fine; if an
 * org ever accumulates several years, bucket to weeks above ~800 days.
 */
export function fillDateGaps(rows: TrendPoint[]): TrendPoint[] {
  if (rows.length < 2) return rows

  const byDate = new Map(rows.map((r) => [r.date, r]))
  const start = toUtc(rows[0].date)
  const end = toUtc(rows[rows.length - 1].date)

  const filled: TrendPoint[] = []
  for (let t = start; t <= end; t += DAY_MS) {
    const date = fromUtc(t)
    filled.push(byDate.get(date) ?? { date, ...ZERO })
  }
  return filled
}

/** Total spend per agent across the range, for the small-multiples captions. */
export function totalsByAgent(rows: TrendPoint[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const agent of AGENTS) {
    totals[agent.id] = rows.reduce((sum, r) => sum + (r[agent.costKey] as number), 0)
  }
  return totals
}
