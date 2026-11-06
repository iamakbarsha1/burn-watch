import { describe, it, expect } from 'vitest'
import { formatRange, formatAgo, formatCost, resolveRange, rangePresets, ALL_TIME_FROM } from './format'
import type { RangeParams } from './format'

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
  const nov6 = new Date('2026-11-06T12:00:00.000Z')

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

  it('resolves a rolling token against the clock, not the day it was written', () => {
    expect(resolveRange({ range: '7d' }, now)).toEqual({ from: '2026-10-30', to: '2026-11-05' })
    expect(resolveRange({ range: '7d' }, nov6)).toEqual({ from: '2026-10-31', to: '2026-11-06' })
  })

  it('pins the single-day tokens to one date at both ends', () => {
    expect(resolveRange({ range: 'today' }, now)).toEqual({ from: '2026-11-05', to: '2026-11-05' })
    expect(resolveRange({ range: 'yesterday' }, now)).toEqual({
      from: '2026-11-04',
      to: '2026-11-04',
    })
    expect(resolveRange({ range: '30d' }, now)).toEqual({ from: '2026-10-07', to: '2026-11-05' })
    expect(resolveRange({ range: 'all' }, nov6)).toEqual({ from: ALL_TIME_FROM, to: '2026-11-06' })
  })

  it('lets the token win over a stale from/to in the same URL', () => {
    expect(resolveRange({ range: '7d', from: '2026-01-01', to: '2026-01-08' }, now)).toEqual({
      from: '2026-10-30',
      to: '2026-11-05',
    })
  })

  it('ignores a token it does not know instead of throwing', () => {
    expect(resolveRange({ range: 'last-fortnight', from: '2026-10-07' }, now)).toEqual({
      from: '2026-10-07',
      to: '2026-11-05',
    })
    expect(resolveRange({ range: 'last-fortnight' }, now)).toEqual({
      from: ALL_TIME_FROM,
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

describe('rangePresets', () => {
  const nov5 = new Date('2026-11-05T12:00:00Z')
  const nov6 = new Date('2026-11-06T12:00:00Z')
  const find = (params: RangeParams, label: string) =>
    rangePresets(params).find((p) => p.label === label)!
  /** The whole URL DateRangePicker writes when a preset is clicked. */
  const clickUrl = (label: string): RangeParams => ({ range: find({}, label).token })

  it('keeps Last 7 days rolling the morning after the click', () => {
    // The defect. Clicking the preset wrote that day's absolute dates, so the
    // bookmark froze on whichever week the reader happened to click. The round
    // trip through the producer is what catches it — a hand written URL would
    // only encode what we already believe the producer writes.
    const url = clickUrl('Last 7 days')
    expect(resolveRange(url, nov5)).toEqual({ from: '2026-10-30', to: '2026-11-05' })
    expect(resolveRange(url, nov6)).toEqual({ from: '2026-10-31', to: '2026-11-06' })
    expect(find(url, 'Last 7 days').active).toBe(true)
  })

  it('keeps All time lit the next morning, on the URL its own click produced', () => {
    // 69bd104 patched this once by leaving `to` off the URL, which only works
    // because All time has a pinned start. The token holds for a rolling
    // window too, where both ends have to move.
    const url = clickUrl('All time')
    expect(resolveRange(url, nov6)).toEqual({ from: ALL_TIME_FROM, to: '2026-11-06' })
    expect(find(url, 'All time').active).toBe(true)
  })

  it('lights All time on a bare URL with no query string', () => {
    expect(find({}, 'All time').active).toBe(true)
  })

  it('lights nothing for a hand picked range', () => {
    expect(rangePresets({ from: '2026-11-05', to: '2026-11-05' }).filter((p) => p.active))
      .toEqual([])
  })

  it('lights nothing for a legacy all-time bookmark', () => {
    // Accepted regression. `?from=2020-01-01` still shows all-time data, but it
    // is a pinned range now and no button claims otherwise. The older reading,
    // that a range starting at the floor is All time, lied about a range that
    // ends last June, so neither of these lights up.
    expect(find({ from: ALL_TIME_FROM, to: '2026-11-06' }, 'All time').active).toBe(false)
    expect(find({ from: ALL_TIME_FROM, to: '2026-06-01' }, 'All time').active).toBe(false)
  })

  it('lets the token light the button over a stale from/to alongside it', () => {
    expect(find({ range: '7d', from: '2026-01-01', to: '2026-01-08' }, 'Last 7 days').active)
      .toBe(true)
  })

  it('lights exactly one preset for a token, and none for a token it does not know', () => {
    const lit = (params: RangeParams) =>
      rangePresets(params).filter((p) => p.active).map((p) => p.label)
    expect(lit({ range: 'yesterday' })).toEqual(['Yesterday'])
    expect(lit({ range: 'last-fortnight' })).toEqual([])
  })

  it('offers the five presets in order, each with its token', () => {
    expect(rangePresets({}).map((p) => [p.label, p.token])).toEqual([
      ['Today', 'today'],
      ['Yesterday', 'yesterday'],
      ['Last 7 days', '7d'],
      ['Last 30 days', '30d'],
      ['All time', 'all'],
    ])
  })
})
