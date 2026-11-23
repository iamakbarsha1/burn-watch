import { AgentNameSchema, type UsageEvent, type UsagePayloadInput } from '@burn-watch/shared'
import { hasConfig, loadConfig } from '../lib/config.js'
import { ReferenceCollector } from '../collectors/reference.js'
import { PARSERS, UsageCollector } from '../collectors/usage.js'
import { formatShape, readShape, shapeRoots } from '../collectors/shape.js'

// Temporary: deleted with the reference collector (design phase 3).

type Side = { tokens: [number, number, number, number]; cost: number; unpriced: boolean }
export type CompareRow = { date: string; agent: string; model: string; ref: Side | null; own: Side | null }
export type DayCheck = { date: string; agent: string; refCost: number; ownCost: number; ok: boolean; why: string[] }

const side = (e: UsageEvent): Side => ({
  tokens: [e.inputTokens, e.outputTokens, e.cacheCreateTokens, e.cacheReadTokens],
  cost: e.costUsd,
  unpriced: e.unpriced === true,
})

const total = (s: Side | null) => (s ? s.tokens.reduce((a, b) => a + b, 0) : 0)

/** The last `n` closed UTC days, oldest first. */
export function closedUtcDays(n: number, now = Date.now()): string[] {
  const today = Math.floor(now / 86_400_000) * 86_400_000
  return Array.from({ length: n }, (_, i) => new Date(today - (n - i) * 86_400_000).toISOString().slice(0, 10))
}

/** One row per (date, agent, model) seen on either side. */
export function compareRows(ref: Map<string, UsageEvent[]>, own: Map<string, UsageEvent[]>): CompareRow[] {
  const rows = new Map<string, CompareRow>()
  const add = (events: Map<string, UsageEvent[]>, which: 'ref' | 'own') => {
    for (const list of events.values()) {
      for (const e of list) {
        const k = `${e.date}\0${e.agent}\0${e.modelName}`
        const row = rows.get(k) ?? { date: e.date, agent: e.agent, model: e.modelName, ref: null, own: null }
        row[which] = side(e)
        rows.set(k, row)
      }
    }
  }
  add(ref, 'ref')
  add(own, 'own')
  return [...rows.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model),
  )
}

/**
 * Acceptance per (date, agent): all four token counts exact on every model
 * row, cost within 0.5% (or $0.01 on a day under $2), and no unpriced model
 * the reference prices.
 */
export function checkDays(rows: CompareRow[]): DayCheck[] {
  const days = new Map<string, DayCheck>()
  for (const r of rows) {
    const k = `${r.date}\0${r.agent}`
    const d = days.get(k) ?? { date: r.date, agent: r.agent, refCost: 0, ownCost: 0, ok: true, why: [] }
    d.refCost += r.ref?.cost ?? 0
    d.ownCost += r.own?.cost ?? 0
    const same = r.ref !== null && r.own !== null && r.ref.tokens.every((t, i) => t === r.own!.tokens[i])
    if (!same) d.why.push(`${r.model}: tokens ${total(r.ref)} / ${total(r.own)}`)
    if (r.own?.unpriced && (r.ref?.cost ?? 0) > 0) d.why.push(`${r.model}: unpriced here, priced by reference`)
    days.set(k, d)
  }
  for (const d of days.values()) {
    const gap = Math.abs(d.ownCost - d.refCost)
    const costOk = d.refCost < 2 ? gap <= 0.01 : gap <= d.refCost * 0.005
    if (!costOk) d.why.push(`cost $${d.refCost.toFixed(4)} / $${d.ownCost.toFixed(4)}`)
    d.ok = d.why.length === 0
  }
  return [...days.values()]
}

/**
 * Shadow mode in sync: one day's check and the payload's referenceDiff, for
 * the agents we parse. Both sides must already bucket days the same way.
 */
export function shadowDay(
  date: string,
  ref: UsageEvent[],
  own: UsageEvent[],
): { checks: DayCheck[]; referenceDiff: NonNullable<UsagePayloadInput['referenceDiff']> } {
  const ours = new Set<string>(PARSERS.map((p) => p.agent))
  const rows = compareRows(new Map([[date, ref]]), new Map([[date, own]])).filter((r) => ours.has(r.agent))
  const byAgent = new Map<string, { refTokens: number; ownTokens: number; refCostUsd: number; ownCostUsd: number }>()
  for (const r of rows) {
    const a = byAgent.get(r.agent) ?? { refTokens: 0, ownTokens: 0, refCostUsd: 0, ownCostUsd: 0 }
    a.refTokens += total(r.ref)
    a.ownTokens += total(r.own)
    a.refCostUsd += r.ref?.cost ?? 0
    a.ownCostUsd += r.own?.cost ?? 0
    byAgent.set(r.agent, a)
  }
  const round = (x: number) => Math.round(x * 1e6) / 1e6
  return {
    checks: checkDays(rows),
    referenceDiff: [...byAgent].map(([agent, a]) => ({
      agent: AgentNameSchema.parse(agent),
      refTokens: a.refTokens,
      ownTokens: a.ownTokens,
      refCostUsd: round(a.refCostUsd),
      ownCostUsd: round(a.ownCostUsd),
    })),
  }
}

const num = (x: number) => x.toLocaleString('en-US')
const pct = (ref: number, own: number) =>
  ref === 0 ? (own === 0 ? '0%' : 'n/a') : `${own >= ref ? '+' : ''}${(((own - ref) / ref) * 100).toFixed(3)}%`

export function formatRow(r: CompareRow): string {
  const rt = total(r.ref)
  const ot = total(r.own)
  const tokens = `${r.ref ? num(rt) : '-'} / ${r.own ? (r.ref && rt === ot ? 'same' : num(ot)) : '-'}`
  const cost = `$${(r.ref?.cost ?? 0).toFixed(4)} / $${(r.own?.cost ?? 0).toFixed(4)}`
  return [r.date, r.agent.padEnd(7), r.model.padEnd(24), tokens.padEnd(30), cost.padEnd(24), pct(r.ref?.cost ?? 0, r.own?.cost ?? 0)].join('  ')
}

export async function compareCommand(options: { days?: string; agent?: string; dumpShape?: string }) {
  if (options.dumpShape) {
    const agent = AgentNameSchema.safeParse(options.dumpShape)
    if (!agent.success) {
      console.error(`[burnwatch] Unknown agent "${options.dumpShape}". One of: ${AgentNameSchema.options.join(', ')}`)
      process.exit(1)
    }
    const roots = shapeRoots(agent.data)
    for (const line of formatShape(agent.data, roots, await readShape(roots))) console.log(line)
    return
  }
  const days = Number(options.days ?? '14')
  if (!Number.isInteger(days) || days < 1) {
    console.error(`[burnwatch] --days must be a positive whole number, got "${options.days}"`)
    process.exit(1)
  }
  const ours = new Set<string>(PARSERS.map((p) => p.agent))
  if (options.agent && !ours.has(options.agent)) {
    console.error(`[burnwatch] No own parser for "${options.agent}" yet. Have: ${[...ours].join(', ')}`)
    process.exit(1)
  }
  const dates = closedUtcDays(days)
  const npx = hasConfig() ? (loadConfig().npxPath ?? 'npx') : 'npx'
  // UTC days on both sides; offline prices take network timing out.
  const reference = new ReferenceCollector(npx, ['--timezone', 'UTC', '--offline'])
  const own = new UsageCollector()

  console.log(`[burnwatch] Comparing ${dates[0]}..${dates[dates.length - 1]} (UTC days)`)
  const [refMap, ownMap] = await Promise.all([reference.collectRange(dates), own.collectRange(dates)])

  const rows = compareRows(refMap, ownMap).filter((r) => ours.has(r.agent) && (!options.agent || r.agent === options.agent))
  const checks = checkDays(rows)

  console.log(['date      ', 'agent  ', 'model'.padEnd(24), 'tokens ref / own'.padEnd(30), 'cost ref / own'.padEnd(24), 'diff'].join('  '))
  for (const r of rows) console.log(formatRow(r))
  for (const [agent, st] of Object.entries(own.summary.stats)) {
    if (st) console.log(`[burnwatch] ${agent}: ${st.files} files, ${st.badLines} bad lines, ${st.noZone} without zone, ${st.nonStandard} non-standard tier`)
  }

  const failed = checks.filter((c) => !c.ok)
  for (const c of failed) console.log(`[burnwatch] FAIL ${c.date} ${c.agent}: ${c.why.join('; ')}`)
  console.log(`[burnwatch] ${checks.length - failed.length}/${checks.length} agent-days pass`)
  if (failed.length > 0) process.exit(1)
}
