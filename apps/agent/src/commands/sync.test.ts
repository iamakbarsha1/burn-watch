import { describe, it, expect } from 'vitest'
import { selectDates } from './sync.js'

function isoDate(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}

describe('selectDates', () => {
  it('defaults to yesterday when no option is passed', () => {
    expect(selectDates({})).toEqual([isoDate(1)])
  })

  it('syncs today when --today is passed', () => {
    expect(selectDates({ today: true })).toEqual([isoDate(0)])
  })

  it('syncs an explicit date when --date is passed', () => {
    expect(selectDates({ date: '2026-01-01' })).toEqual(['2026-01-01'])
  })

  it('backfills the last 7 days when --last-7 is passed', () => {
    expect(selectDates({ last7: true })).toEqual([
      isoDate(7),
      isoDate(6),
      isoDate(5),
      isoDate(4),
      isoDate(3),
      isoDate(2),
      isoDate(1),
    ])
  })

  it('backfills N days when --days is passed', () => {
    expect(selectDates({ days: '3' })).toEqual([isoDate(3), isoDate(2), isoDate(1)])
  })

  it('returns no dates for --days 0', () => {
    expect(selectDates({ days: '0' })).toEqual([])
  })

  it('prioritizes --days over --last-7, --date, and --today', () => {
    expect(selectDates({ days: '2', last7: true, date: '2026-01-01', today: true })).toEqual([
      isoDate(2),
      isoDate(1),
    ])
  })

  it('prioritizes --date over --today', () => {
    expect(selectDates({ date: '2026-01-01', today: true })).toEqual(['2026-01-01'])
  })
})
