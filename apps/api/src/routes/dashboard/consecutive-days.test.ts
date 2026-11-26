import { describe, it, expect } from 'vitest'
import { consecutiveDays } from './consecutive-days.js'

// 2026-11-16 is a Monday.
const MON = '2026-11-16'
const TUE = '2026-11-17'
const WED = '2026-11-18'
const THU = '2026-11-19'
const FRI = '2026-11-20'
const SAT = '2026-11-21'
const SUN = '2026-11-22'
const NEXT_MON = '2026-11-23'

describe('consecutiveDays', () => {
  it('gives 0/0/null for no active days', () => {
    expect(consecutiveDays([], SUN)).toEqual({ current: 0, longest: 0, lastActive: null })
  })

  it('breaks on a missing weekday', () => {
    expect(consecutiveDays([MON, WED, THU], THU)).toEqual({ current: 2, longest: 2, lastActive: THU })
  })

  it('does not break on a missing weekend', () => {
    expect(consecutiveDays([THU, FRI, NEXT_MON], NEXT_MON).current).toBe(3)
  })

  it('counts weekend activity in the run', () => {
    expect(consecutiveDays([FRI, SAT, SUN, NEXT_MON], NEXT_MON)).toMatchObject({ current: 4, longest: 4 })
  })

  it('keeps the current run when the last active day is yesterday', () => {
    expect(consecutiveDays([MON, TUE, WED], THU).current).toBe(3)
  })

  it('keeps the current run when today and yesterday are both missing', () => {
    expect(consecutiveDays([MON, TUE], THU).current).toBe(2)
  })

  it('keeps the current run for Friday seen on Sunday and on Monday', () => {
    expect(consecutiveDays([THU, FRI], SUN).current).toBe(2)
    expect(consecutiveDays([THU, FRI], NEXT_MON).current).toBe(2)
  })

  it('sets current to 0 after a missed weekday before yesterday', () => {
    expect(consecutiveDays([MON], THU)).toEqual({ current: 0, longest: 1, lastActive: MON })
    expect(consecutiveDays([THU, FRI], '2026-11-25').current).toBe(0) // Wed: Monday left out
  })

  it('keeps the longest run when the current one is shorter', () => {
    expect(consecutiveDays([MON, TUE, WED, FRI], FRI)).toMatchObject({ current: 1, longest: 3 })
  })

  it('ignores order and duplicates', () => {
    expect(consecutiveDays([WED, MON, TUE, TUE, MON], WED)).toEqual({ current: 3, longest: 3, lastActive: WED })
  })

  it('runs across month and year ends', () => {
    // 2026-12-31 is a Thursday, 2027-01-01 a Friday, 2027-01-04 a Monday.
    expect(consecutiveDays(['2026-11-30', '2026-12-01'], '2026-12-01').current).toBe(2)
    expect(consecutiveDays(['2026-12-31', '2027-01-01', '2027-01-04'], '2027-01-04')).toMatchObject({ current: 3, longest: 3 })
  })
})
