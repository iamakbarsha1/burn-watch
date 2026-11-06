import { describe, it, expect } from 'vitest'
import { formatRange, formatAgo, formatCost, resolveRange, rangePresets, ALL_TIME_FROM } from './format'

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

describe('rangePresets', () => {
  const nov5 = new Date('2026-11-05T12:00:00Z')
  const nov6 = new Date('2026-11-06T12:00:00Z')
  const find = (params: { from?: string | null; to?: string | null }, label: string, now: Date) =>
    rangePresets(params, now).find((p) => p.label === label)!

  it('gives All time no end date, so clicking it leaves `to` off the URL', () => {
    expect(find({}, 'All time', nov5)).toMatchObject({ from: ALL_TIME_FROM, to: null })
  })

  it('keeps All time lit the next morning, on the URL its own click produced', () => {
    // The regression, and the reason this is a round trip rather than a hand
    // written URL: clicking All time wrote today into `to`, so the bookmark it
    // produced stopped matching any preset once the date rolled over. Feeding
    // the preset's own output back in is what catches that.
    const clicked = find({}, 'All time', nov5)
    const url = { from: clicked.from, to: clicked.to }
    expect(find(url, 'All time', nov5).active).toBe(true)
    expect(find(url, 'All time', nov6).active).toBe(true)
  })

  it('does not call a range All time just because it starts at the floor', () => {
    // Matching on `from` alone was the other candidate fix. This range hides
    // five months, so lighting the button up would be a lie.
    expect(find({ from: ALL_TIME_FROM, to: '2026-06-01' }, 'All time', nov6).active).toBe(false)
  })

  it('still matches an explicit `to` of today', () => {
    expect(find({ from: ALL_TIME_FROM, to: '2026-11-06' }, 'All time', nov6).active).toBe(true)
  })

  it('leaves the dated presets pinned to real dates', () => {
    expect(find({}, 'Yesterday', nov6)).toMatchObject({ from: '2026-11-05', to: '2026-11-05' })
    expect(find({}, 'Today', nov6)).toMatchObject({ from: '2026-11-06', to: '2026-11-06' })
    expect(find({}, 'Last 7 days', nov6)).toMatchObject({ from: '2026-10-31', to: '2026-11-06' })
  })

  it('marks exactly one preset active for a given URL', () => {
    const active = rangePresets({ from: '2026-11-05', to: '2026-11-05' }, nov6).filter((p) => p.active)
    expect(active.map((p) => p.label)).toEqual(['Yesterday'])
  })
})
