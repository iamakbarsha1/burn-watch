import { describe, it, expect } from 'vitest'
import type { Document } from 'mongodb'
import type { IsoDate, OrgId, UserId } from '@burn-watch/db'
import { countFunnel, daysUnused, funnelThresholds, funnelUsersPipeline, stageOf, type FunnelPerson } from './adoption.js'
import { daysBefore } from './dates.js'

/**
 * The A3 stage rules as plain code. What the pipeline counts against a real
 * server is checked in `src/scripts/dashboard-pipelines.ts`.
 */
const TODAY = '2026-11-22' as IsoDate
const WEEK = funnelThresholds(daysBefore(TODAY, 6), TODAY)
const MONTH = funnelThresholds(daysBefore(TODAY, 29), TODAY)
const DAY = funnelThresholds(TODAY, TODAY)

const person = (over: Partial<FunnelPerson> = {}): FunnelPerson => ({
  userId: 'u1' as UserId,
  name: 'Ada',
  email: null,
  teamIds: [],
  since: '2026-11-05' as IsoDate,
  hasDevice: true,
  firstSync: '2026-11-06' as IsoDate,
  lastSync: '2026-11-20' as IsoDate,
  activeDays: 0,
  ...over,
})

describe('funnelThresholds', () => {
  it('scales active and power days with the range length', () => {
    expect(DAY).toEqual({ rangeDays: 1, activeDays: 1, powerDays: 1 })
    expect(WEEK).toEqual({ rangeDays: 7, activeDays: 2, powerDays: 5 })
    expect(MONTH).toEqual({ rangeDays: 30, activeDays: 2, powerDays: 22 })
  })
})

describe('stageOf', () => {
  it('places an invite, a user with no usage, and a user who synced', () => {
    expect(stageOf(person({ userId: null, name: null, email: 'x@example.invalid' }), WEEK)).toBe('invited')
    expect(stageOf(person({ firstSync: null, lastSync: null }), WEEK)).toBe('registered')
    expect(stageOf(person({ activeDays: 0 }), WEEK)).toBe('firstSync')
  })

  it('counts a first sync from before the account was created', () => {
    expect(stageOf(person({ since: '2026-11-05' as IsoDate, firstSync: '2026-03-17' as IsoDate }), WEEK)).toBe('firstSync')
  })

  it('needs 2 days for active and exactly 5 of 7 for power user', () => {
    expect(stageOf(person({ activeDays: 1 }), WEEK)).toBe('firstSync')
    expect(stageOf(person({ activeDays: 2 }), WEEK)).toBe('active')
    expect(stageOf(person({ activeDays: 4 }), WEEK)).toBe('active')
    expect(stageOf(person({ activeDays: 5 }), WEEK)).toBe('powerUser')
  })

  it('needs 22 of 30 days for power user on a 30-day range', () => {
    expect(stageOf(person({ activeDays: 21 }), MONTH)).toBe('active')
    expect(stageOf(person({ activeDays: 22 }), MONTH)).toBe('powerUser')
  })

  it('makes one day of use both active and power user on a 1-day range', () => {
    expect(stageOf(person({ activeDays: 0 }), DAY)).toBe('firstSync')
    expect(stageOf(person({ activeDays: 1 }), DAY)).toBe('powerUser')
  })
})

describe('countFunnel', () => {
  it('counts each stage as a subset of the one before, with devices on users only', () => {
    const people = [
      person({ userId: null, name: null, email: 'x@example.invalid', hasDevice: false, firstSync: null }),
      person({ hasDevice: false, firstSync: null, lastSync: null }),
      person({ activeDays: 1 }),
      person({ activeDays: 3 }),
      person({ activeDays: 7 }),
    ]
    expect(countFunnel(people, WEEK)).toEqual({
      invited: 5,
      registered: 4,
      deviceLinked: 3,
      firstSync: 3,
      active: 2,
      powerUser: 1,
    })
  })

  it('is all zero for nobody', () => {
    expect(countFunnel([], WEEK)).toEqual({ invited: 0, registered: 0, deviceLinked: 0, firstSync: 0, active: 0, powerUser: 0 })
  })
})

describe('funnelUsersPipeline', () => {
  const ORG = 'ORG' as OrgId
  const from = daysBefore(TODAY, 6)
  const pipeline = funnelUsersPipeline(ORG, from, TODAY)
  const usage = pipeline.find((s) => s.$lookup?.from === 'dailySnapshots')!.$lookup.pipeline as Document[]

  it('reads active users of the org only, narrowed to the scope when there is one', () => {
    expect(pipeline[0]).toEqual({ $match: { orgId: ORG, isActive: true } })
    expect(funnelUsersPipeline(ORG, from, TODAY, ['u1' as UserId])[0]).toEqual({
      $match: { orgId: ORG, isActive: true, _id: { $in: ['u1'] } },
    })
  })

  it('ignores zero-token days and counts active days inside the range ends, both included', () => {
    expect(usage[0]).toEqual({ $match: { totalTokens: { $gt: 0 } } })
    // today - 6 is the first day of a 7-day range, today - 7 falls outside it.
    expect(usage[1].$group.activeDays).toEqual({
      $sum: { $cond: [{ $and: [{ $gte: ['$date', '2026-11-16'] }, { $lte: ['$date', TODAY] }] }, 1, 0] },
    })
  })
})

describe('daysUnused', () => {
  const seat = { startDate: '2026-11-01' }

  it('is 0 for a seat used today', () => {
    expect(daysUnused(seat, TODAY, TODAY)).toBe(0)
  })

  it('counts the days after the last use, today included', () => {
    expect(daysUnused(seat, '2026-11-20', TODAY)).toBe(2)
  })

  it('counts a never-used seat from its start date, today included', () => {
    expect(daysUnused(seat, null, TODAY)).toBe(22)
    expect(daysUnused({ startDate: TODAY }, null, TODAY)).toBe(1)
  })

  it('ignores use before the seat started', () => {
    expect(daysUnused(seat, '2026-10-15', TODAY)).toBe(22)
    // The day before the start counts the same as never used.
    expect(daysUnused(seat, '2026-10-31', TODAY)).toBe(22)
  })
})
