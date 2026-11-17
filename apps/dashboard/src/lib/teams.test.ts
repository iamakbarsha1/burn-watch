import { describe, it, expect } from 'vitest'
import type { Team, TeamComparison } from '@burn-watch/shared'
import { pickTeam, teamDailyRows } from './teams'

const team = (id: string): Team => ({ id, name: id, members: [] })

function compare(teamId: string, daily: [string, number][]): TeamComparison {
  return {
    teamId,
    name: teamId,
    memberCount: 1,
    activeUsers: 1,
    totalCostUsd: 0,
    totalTokens: 0,
    byAgent: [],
    daily: daily.map(([date, totalCost]) => ({ date, totalCost })),
  }
}

describe('pickTeam', () => {
  it('keeps an id the viewer can read', () => {
    expect(pickTeam([team('a'), team('b')], 'b')?.id).toBe('b')
  })
  it('drops a missing, stale or foreign id', () => {
    expect(pickTeam([team('a')], undefined)).toBeUndefined()
    expect(pickTeam([team('a')], 'zzz')).toBeUndefined()
    expect(pickTeam([], 'a')).toBeUndefined()
  })
})

describe('teamDailyRows', () => {
  it('is empty when no team reported', () => {
    expect(teamDailyRows([compare('a', [])])).toEqual([])
  })

  it('pivots per team and fills gaps with 0 across the union of days', () => {
    const rows = teamDailyRows([
      compare('a', [['2026-11-01', 5], ['2026-11-03', 2]]),
      compare('b', [['2026-11-02', 7]]),
    ])
    expect(rows).toEqual([
      { date: '2026-11-01', a: 5, b: 0 },
      { date: '2026-11-02', a: 0, b: 7 },
      { date: '2026-11-03', a: 2, b: 0 },
    ])
  })

  it('crosses a month boundary in UTC', () => {
    const rows = teamDailyRows([compare('a', [['2026-10-31', 1], ['2026-11-01', 1]])])
    expect(rows.map((r) => r.date)).toEqual(['2026-10-31', '2026-11-01'])
  })
})
