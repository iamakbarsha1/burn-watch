import { describe, it, expect } from 'vitest'
import { formatRange, formatAgo, ALL_TIME_FROM } from './format'

describe('dashboard test wiring', () => {
  it('runs vitest in the dashboard workspace', () => {
    expect(new Intl.NumberFormat('en-US').format(1000)).toBe('1,000')
  })
})

describe('formatRange', () => {
  it('names the all-time floor instead of printing it', () => {
    expect(formatRange(ALL_TIME_FROM, '2026-11-05')).toBe('All time')
  })

  it('treats anything below the floor as all time too', () => {
    expect(formatRange('2019-06-01', '2026-11-05')).toBe('All time')
  })

  it('collapses a single day to one date', () => {
    expect(formatRange('2026-11-05', '2026-11-05')).toBe('2026-11-05')
  })

  it('keeps a real range as a range', () => {
    expect(formatRange('2026-10-07', '2026-11-05')).toBe('2026-10-07 — 2026-11-05')
  })
})

describe('formatAgo', () => {
  const now = new Date('2026-11-05T12:00:00.000Z')

  it('returns null for a user who has never reported', () => {
    expect(formatAgo(null, now)).toBeNull()
  })

  it('returns null rather than "NaNd ago" for an unparseable timestamp', () => {
    expect(formatAgo('not-a-date', now)).toBeNull()
  })

  it.each([
    ['2026-11-05T11:59:30.000Z', 'just now'],
    ['2026-11-05T11:15:00.000Z', '45m ago'],
    ['2026-11-05T09:00:00.000Z', '3h ago'],
    ['2026-11-01T12:00:00.000Z', '4d ago'],
  ])('renders %s as %s', (iso, expected) => {
    expect(formatAgo(iso, now)).toBe(expected)
  })
})
