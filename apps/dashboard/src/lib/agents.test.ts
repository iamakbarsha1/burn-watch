import { describe, it, expect } from 'vitest'
import type { TrendPoint } from '@burn-watch/shared'
import { fillDateGaps, totalsByAgent, AGENTS } from './agents'

function point(date: string, claudeCost = 0): TrendPoint {
  return {
    date,
    claudeCost,
    qwenCost: 0,
    geminiCost: 0,
    codexCost: 0,
    copilotCost: 0,
    totalCost: claudeCost,
    claudeTokens: 0,
    qwenTokens: 0,
    totalTokens: 0,
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
