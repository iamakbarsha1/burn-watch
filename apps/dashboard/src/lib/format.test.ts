import { describe, it, expect } from 'vitest'
import { formatRange, formatAgo, formatCost, resolveRange, ALL_TIME_FROM } from './format'

describe('formatCost', () => {
  it('groups thousands so a four-figure total reads at a glance', () => {
    expect(formatCost(3038.53)).toBe('$3,038.53')
    expect(formatCost(2983.5)).toBe('$2,983.50')
  })

  it('keeps the zero and sub-cent cases', () => {
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(12.5)).toBe('$12.50')
  })
})

describe('resolveRange', () => {
  const now = new Date('2026-11-05T12:00:00.000Z')

  it('defaults to all time rather than today', () => {
    // A dashboard defaulting to "today" opens empty most mornings, because the
    // agent uploads yesterday on a 6 PM schedule.
    expect(resolveRange({}, now)).toEqual({ from: ALL_TIME_FROM, to: '2026-11-05' })
  })

  it('honours an explicit range', () => {
    expect(resolveRange({ from: '2026-10-07', to: '2026-11-05' }, now)).toEqual({
      from: '2026-10-07',
      to: '2026-11-05',
    })
  })

  it('swaps a backwards range instead of returning an empty set', () => {
    expect(resolveRange({ from: '2026-11-05', to: '2026-10-07' }, now)).toEqual({
      from: '2026-10-07',
      to: '2026-11-05',
    })
  })

  it('fills in only the missing half', () => {
    expect(resolveRange({ from: '2026-10-01' }, now)).toEqual({
      from: '2026-10-01',
      to: '2026-11-05',
    })
  })
})

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
