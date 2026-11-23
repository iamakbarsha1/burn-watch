import { existsSync } from 'fs'
import { FREE_TIER_AGENTS, type PriceTable, type UsageEvent } from '@burn-watch/shared'
import type { UsageCollector as Collector } from './base.js'
import { claudeParser } from './parsers/claude.js'
import { emptyStats, type AgentParser, type ParseStats, type UsageRecord } from './parsers/types.js'
import { loadPriceTable, priceRecord } from './pricing.js'

/** Agents BurnWatch collects. An agent with no parser here is not collected. */
export const PARSERS: AgentParser[] = [claudeParser]

export type CollectSummary = {
  stats: Partial<Record<string, ParseStats>>
  unpriced: Record<string, number> // model -> tokens
}

/**
 * BurnWatch's own usage collector: reads each agent's local logs, dedupes
 * requests, prices each one, and groups them by (UTC date, agent, model).
 */
export class UsageCollector implements Collector {
  summary: CollectSummary = { stats: {}, unpriced: {} }

  constructor(
    private parsers: AgentParser[] = PARSERS,
    private table: PriceTable = loadPriceTable(),
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.parsers.some((p) => p.roots().some((r) => existsSync(r)))
  }

  async collect(date: string): Promise<UsageEvent[]> {
    return (await this.collectRange([date])).get(date) ?? []
  }

  async collectRange(dates: string[]): Promise<Map<string, UsageEvent[]>> {
    const result = new Map<string, UsageEvent[]>()
    this.summary = { stats: {}, unpriced: {} }
    if (dates.length === 0) return result
    const wanted = new Set(dates)
    // A day before the first date, so a copy written just before midnight is seen.
    const since = new Date(Date.parse(`${[...dates].sort()[0]}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    // Dedupe before the date filter. The earliest copy of a request decides its
    // day: a streamed reply can write its lines either side of midnight.
    const first = new Map<string, UsageRecord>()

    for (const parser of this.parsers) {
      const roots = parser.roots().filter((r) => existsSync(r))
      if (roots.length === 0) continue
      const stats = (this.summary.stats[parser.agent] = emptyStats())
      for await (const r of parser.read(roots, since, stats)) {
        const key = `${r.agent}:${r.key}`
        const prev = first.get(key)
        if (!prev || r.at < prev.at) first.set(key, r)
      }
    }

    const groups = new Map<string, UsageEvent>()
    for (const r of first.values()) {
      const date = r.at.slice(0, 10)
      if (!wanted.has(date)) continue
      const free = FREE_TIER_AGENTS.has(r.agent)
      const cost = free ? 0 : priceRecord(this.table, r)
      const tokens = r.input + r.output + r.cacheWrite5m + r.cacheWrite1h + r.cacheRead
      if (cost === null) this.summary.unpriced[r.model] = (this.summary.unpriced[r.model] ?? 0) + tokens

      const gk = `${date}\0${r.agent}\0${r.model}`
      let e = groups.get(gk)
      if (!e) {
        e = {
          agent: r.agent,
          date,
          modelName: r.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          isFreeTier: free,
          ...(cost === null ? { unpriced: true } : {}),
        }
        groups.set(gk, e)
        if (!result.has(date)) result.set(date, [])
        result.get(date)!.push(e)
      }
      e.inputTokens += r.input
      e.outputTokens += r.output
      e.cacheCreateTokens += r.cacheWrite5m + r.cacheWrite1h
      e.cacheReadTokens += r.cacheRead
      e.totalTokens += tokens
      e.costUsd += cost ?? 0
    }
    return result
  }
}
