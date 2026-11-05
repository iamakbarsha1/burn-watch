import { describe, it, expect } from 'vitest'
import type { TrendPoint } from '@burn-watch/shared'
import { fillDateGaps, totalsByAgent, tokensByAgent, agentPanels, AGENTS } from './agents'

function point(date: string, claudeCost = 0, qwenTokens = 0): TrendPoint {
  return {
    date,
    claudeCost,
    qwenCost: 0,
    geminiCost: 0,
    codexCost: 0,
    copilotCost: 0,
    totalCost: claudeCost,
    claudeTokens: 0,
    qwenTokens,
    totalTokens: qwenTokens,
  }
}

describe('fillDateGaps', () => {
  it('inserts a zero row for every skipped day', () => {
    const filled = fillDateGaps([point('2026-03-17', 10), point('2026-03-20', 40)])
    expect(filled.map((r) => r.date)).toEqual([
      '2026-03-17',
      '2026-03-18',
      '2026-03-19',
      '2026-03-20',
    ])
    expect(filled.map((r) => r.claudeCost)).toEqual([10, 0, 0, 40])
  })

  it('spans the data, not the requested all-time floor', () => {
    // The regression this guards: "All time" queries the API from 2020-01-01,
    // so filling to the *requested* from would prepend six years of zeroes.
    const filled = fillDateGaps([point('2026-03-17', 10), point('2026-11-05', 40)])
    expect(filled[0].date).toBe('2026-03-17')
    expect(filled[filled.length - 1].date).toBe('2026-11-05')
    expect(filled).toHaveLength(234)
  })

  it('crosses a month and a DST boundary without drifting a day', () => {
    const filled = fillDateGaps([point('2026-10-30'), point('2026-11-02')])
    expect(filled.map((r) => r.date)).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ])
  })

  it('leaves a single point and an empty set alone', () => {
    expect(fillDateGaps([])).toEqual([])
    expect(fillDateGaps([point('2026-11-05', 5)])).toHaveLength(1)
  })

  it('keeps contiguous data unchanged', () => {
    const rows = [point('2026-11-04', 1), point('2026-11-05', 2)]
    expect(fillDateGaps(rows)).toEqual(rows)
  })
})

describe('AGENTS palette', () => {
  it('gives every agent a distinct hue', () => {
    const hues = new Set(AGENTS.map((a) => a.color))
    expect(hues.size).toBe(AGENTS.length)
  })
})

describe('totalsByAgent', () => {
  it('sums each agent across the range', () => {
    const totals = totalsByAgent([point('2026-11-04', 10), point('2026-11-05', 2.5)])
    expect(totals.claude).toBe(12.5)
    expect(totals.qwen).toBe(0)
  })
})

describe('tokensByAgent', () => {
  it('sums only the agents that carry a token column', () => {
    const tokens = tokensByAgent([point('2026-04-15', 0, 4_000_000), point('2026-04-16', 0, 1_000_000)])
    expect(tokens.qwen).toBe(5_000_000)
    expect(tokens.claude).toBe(0)
    expect(tokens.codex).toBeUndefined()
  })
})

describe('agentPanels', () => {
  // The regression this guards: Qwen is unpriced, so a spend-only filter
  // dropped it from the page even though it had burned a billion tokens.
  it('keeps a zero-cost agent that burned tokens, plotted on tokens', () => {
    const panels = agentPanels([point('2026-04-15', 300, 4_000_000)])
    const qwen = panels.find((p) => p.agent.id === 'qwen')
    expect(qwen).toBeDefined()
    expect(qwen!.free).toBe(true)
    expect(qwen!.dataKey).toBe('qwenTokens')
    expect(qwen!.value).toBe('4.0M tokens')
    expect(qwen!.caption).toBe('free tier · peak 4.0M')
  })

  it('plots a spending agent on cost', () => {
    const claude = agentPanels([point('2026-11-05', 300)]).find((p) => p.agent.id === 'claude')
    expect(claude!.free).toBe(false)
    expect(claude!.dataKey).toBe('claudeCost')
    expect(claude!.value).toBe('$300.00')
  })

  it('drops an agent with neither cost nor tokens', () => {
    const ids = agentPanels([point('2026-11-05', 300)]).map((p) => p.agent.id)
    expect(ids).toEqual(['claude'])
  })
})
