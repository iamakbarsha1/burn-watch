import { describe, expect, it } from 'vitest'
import type { Db, Document } from 'mongodb'
import type { IsoDate, Micros } from './ids.js'
import { MIGRATIONS } from './migrations.js'
import { addDays, seatCost } from './seats.js'

const d = (s: string) => s as IsoDate
// $36.50/mo is $1.20 a day at monthly × 12 ÷ 365.
const seat = { monthlyPriceMicros: 36_500_000 as Micros, startDate: d('2026-11-10') }
const TODAY = d('2026-11-20')

describe('seatCost', () => {
  it('costs nothing for a range that ends before the start date', () => {
    expect(seatCost(seat, d('2026-10-01'), d('2026-11-09'), TODAY)).toBe(0)
  })

  it('bills only the days from the start date when the range straddles it', () => {
    // 10th to 15th inclusive is 6 days.
    expect(seatCost(seat, d('2026-11-01'), d('2026-11-15'), TODAY)).toBe(7_200_000)
  })

  it('caps "All time" at today rather than billing from 2020', () => {
    // 10th to 20th inclusive is 11 days.
    expect(seatCost(seat, d('2020-01-01'), TODAY, TODAY)).toBe(13_200_000)
  })

  it('does not bill days after today when `to` is in the future', () => {
    expect(seatCost(seat, d('2026-11-15'), d('2026-12-31'), TODAY)).toBe(7_200_000)
  })

  it('bills a whole year as twelve months, and rounds to whole micros', () => {
    const monthly = { monthlyPriceMicros: 30_000_000 as Micros, startDate: d('2025-01-01') }
    expect(seatCost(monthly, d('2025-01-01'), d('2025-12-31'), TODAY)).toBe(360_000_000)
    expect(Number.isInteger(seatCost(monthly, d('2025-01-01'), d('2025-01-01'), TODAY))).toBe(true)
  })
})

describe('addDays', () => {
  it('steps across month and year ends in UTC', () => {
    expect(addDays(d('2026-12-31'), 1)).toBe('2027-01-01')
    expect(addDays(d('2026-03-01'), -1)).toBe('2026-02-28')
  })
})

describe('0002_budget_alert_type', () => {
  /** Just enough of updateMany for `{ type: { $exists: false } }` and `$set`. */
  function fakeDb(docs: Document[]): Db {
    const coll = {
      updateMany: async (filter: Document, update: Document) => {
        if (JSON.stringify(filter) !== JSON.stringify({ type: { $exists: false } })) {
          throw new Error(`unsupported filter: ${JSON.stringify(filter)}`)
        }
        for (const doc of docs) if (!('type' in doc)) Object.assign(doc, update.$set)
      },
    }
    return { collection: () => coll } as unknown as Db
  }

  it('backfills untyped alerts as api-spend, leaves typed ones, and is idempotent', async () => {
    const migration = MIGRATIONS.find((m) => m.id === '0002_budget_alert_type')!
    const docs: Document[] = [
      { _id: 'old', monthlyLimitMicros: 1 },
      { _id: 'new', type: 'idle-seat', idleDays: 14, limitHits: null },
    ]
    const db = fakeDb(docs)
    await migration.run(db)
    const once = structuredClone(docs)
    await migration.run(db)
    expect(docs).toEqual(once)
    expect(docs).toEqual([
      { _id: 'old', monthlyLimitMicros: 1, type: 'api-spend', idleDays: null, limitHits: null },
      { _id: 'new', type: 'idle-seat', idleDays: 14, limitHits: null },
    ])
  })
})
