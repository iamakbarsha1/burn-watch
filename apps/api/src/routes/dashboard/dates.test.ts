import { describe, it, expect } from 'vitest'
import type { IsoDate } from '@burn-watch/db'
import { dayBefore, daysBefore, today } from './dates.js'

describe('daysBefore', () => {
  it('steps back one calendar day', () => {
    expect(dayBefore('2026-11-05' as IsoDate)).toBe('2026-11-04')
  })

  it('crosses a month boundary', () => {
    expect(dayBefore('2026-11-01' as IsoDate)).toBe('2026-10-31')
  })

  it('crosses a year boundary', () => {
    expect(dayBefore('2026-01-01' as IsoDate)).toBe('2025-12-31')
  })

  it('handles the leap day', () => {
    expect(dayBefore('2028-03-01' as IsoDate)).toBe('2028-02-29')
  })

  it('steps back across a DST transition, where the old local-clock step did not', () => {
    // 2026-03-29 is the European spring-forward. The arithmetic this replaces
    // held the local clock still and let the offset move underneath it, which
    // lands the resulting instant an hour either side of UTC midnight. These
    // literal expectations hold on any host because nothing here reads an
    // offset.
    expect(dayBefore('2026-03-29' as IsoDate)).toBe('2026-03-28')
    expect(dayBefore('2026-03-30' as IsoDate)).toBe('2026-03-29')
    expect(dayBefore('2026-11-02' as IsoDate)).toBe('2026-11-01')
  })

  it('steps back by a whole window, in the direction its name says', () => {
    // `/trends?days=30` computed its window with `setDate(getDate() - days)`.
    // A sign flip there asks for the next thirty days, which always answers
    // with an empty chart — the same empty chart a quiet month produces.
    expect(daysBefore('2026-11-05' as IsoDate, 30)).toBe('2026-10-06')
    expect(daysBefore('2026-11-05' as IsoDate, 7)).toBe('2026-10-29')
    expect(daysBefore('2026-01-05' as IsoDate, 90)).toBe('2025-10-07')
  })

  it('treats zero days as the same day', () => {
    expect(daysBefore('2026-11-05' as IsoDate, 0)).toBe('2026-11-05')
  })
})

describe('today', () => {
  it('is a plain YYYY-MM-DD, which is what the date fields are keyed by', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('agrees with UTC rather than with the host offset', () => {
    expect(today()).toBe(new Date().toISOString().slice(0, 10))
  })
})
