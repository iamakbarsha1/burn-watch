import { describe, it, expect } from 'vitest'
import type { UsageEvent } from '@burn-watch/shared'
import { checkDays, closedUtcDays, compareRows, shadowDay } from './compare.js'

const ev = (over: Partial<UsageEvent>): UsageEvent => ({
  agent: 'claude',
  date: '2026-11-20',
  modelName: 'claude-opus-5-5',
  inputTokens: 1,
  outputTokens: 2,
  cacheCreateTokens: 3,
  cacheReadTokens: 4,
  totalTokens: 10,
  costUsd: 10,
  isFreeTier: false,
  ...over,
})

const day = (...events: UsageEvent[]) => new Map([['2026-11-20', events]])

describe('compare', () => {
  it('lists closed UTC days, oldest first, not today', () => {
    expect(closedUtcDays(3, Date.parse('2026-11-23T04:57:00Z'))).toEqual(['2026-11-20', '2026-11-21', '2026-11-22'])
  })

  it('passes exact tokens with cost inside 0.5%', () => {
    const [d] = checkDays(compareRows(day(ev({})), day(ev({ costUsd: 10.04 }))))
    expect(d.ok).toBe(true)
  })

  it('fails a token gap in any of the four counts, even when totals match', () => {
    const [d] = checkDays(compareRows(day(ev({})), day(ev({ inputTokens: 2, outputTokens: 1 }))))
    expect(d.ok).toBe(false)
  })

  it('fails cost over 0.5%, and over $0.01 on a day under $2', () => {
    expect(checkDays(compareRows(day(ev({})), day(ev({ costUsd: 10.06 }))))[0].ok).toBe(false)
    expect(checkDays(compareRows(day(ev({ costUsd: 1 })), day(ev({ costUsd: 1.011 }))))[0].ok).toBe(false)
    expect(checkDays(compareRows(day(ev({ costUsd: 1 })), day(ev({ costUsd: 1.009 }))))[0].ok).toBe(true)
  })

  it('fails a model one side lacks, and an unpriced model the reference prices', () => {
    expect(checkDays(compareRows(day(ev({})), day()))[0].ok).toBe(false)
    const [d] = checkDays(compareRows(day(ev({})), day(ev({ costUsd: 10, unpriced: true }))))
    expect(d.why).toContain('claude-opus-5-5: unpriced here, priced by reference')
  })

  it('shadow mode: diffs only agents with an own parser, summed across models', () => {
    const ref = [ev({}), ev({ modelName: 'claude-haiku-5-5', costUsd: 1 }), ev({ agent: 'qwen', modelName: 'qwen3', costUsd: 0 })]
    const own = [ev({ costUsd: 10.000_000_4 }), ev({ modelName: 'claude-haiku-5-5', costUsd: 1 })]
    const { checks, referenceDiff } = shadowDay('2026-11-20', ref, own)
    expect(checks.map((c) => c.agent)).toEqual(['claude'])
    expect(checks[0].ok).toBe(true)
    expect(referenceDiff).toEqual([{ agent: 'claude', refTokens: 20, ownTokens: 20, refCostUsd: 11, ownCostUsd: 11 }])
  })

  it('sums cost per agent-day across models before the threshold', () => {
    const ref = day(ev({ costUsd: 10 }), ev({ modelName: 'claude-haiku-5-5', costUsd: 10 }))
    const own = day(ev({ costUsd: 10.09 }), ev({ modelName: 'claude-haiku-5-5', costUsd: 10 }))
    const checks = checkDays(compareRows(ref, own))
    expect(checks).toHaveLength(1)
    expect(checks[0].ok).toBe(true) // 0.09 on 20 is 0.45%
  })
})
