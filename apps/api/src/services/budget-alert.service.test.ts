import { describe, it, expect } from 'vitest'
import { budgetAlerts, dailySnapshots } from '../../drizzle/schema.js'
import type { DbOrTx } from '../plugins/db.js'
import { costColumnFor, monthToDateSpend, evaluateBudgetAlerts } from './budget-alert.service.js'

const ORG = 'org-1'
const USER = 'user-1'
const DATE = '2026-11-05'

interface AlertRow {
  id: string
  orgId: string
  userId: string | null
  agent: string | null
  monthlyLimitUsd: string
  threshold: string
  trippedAt: Date | null
  createdAt: Date
}

const alert = (over: Partial<AlertRow> = {}): AlertRow => ({
  id: 'alert-1',
  orgId: ORG,
  userId: null,
  agent: null,
  monthlyLimitUsd: '100',
  threshold: '1',
  trippedAt: null,
  createdAt: new Date('2026-01-01'),
  ...over,
})

/**
 * One alert per test, so an update in the recorded list unambiguously belongs
 * to it. `spend` stands in for whatever `monthToDateSpend` would have summed;
 * the real aggregation query is exercised separately below.
 */
function fakeDb(alerts: AlertRow[], spend: unknown) {
  const updates: Record<string, unknown>[] = []

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === budgetAlerts) return Promise.resolve(alerts)
          if (table === dailySnapshots) return Promise.resolve([{ spend }])
          throw new Error('fakeDb: unexpected table in select()')
        },
      }),
    }),
    update: (table: unknown) => {
      if (table !== budgetAlerts) throw new Error('fakeDb: unexpected update table')
      return {
        set: (values: Record<string, unknown>) => ({
          where: () => {
            updates.push(values)
            return Promise.resolve()
          },
        }),
      }
    },
  }

  return { db: db as unknown as DbOrTx, updates }
}

describe('costColumnFor', () => {
  it('picks the per-agent column for a known agent', () => {
    expect(costColumnFor('claude')).toBe(dailySnapshots.claudeCostUsd)
    expect(costColumnFor('qwen')).toBe(dailySnapshots.qwenCostUsd)
  })

  it('falls back to the all-agent total when agent is null', () => {
    expect(costColumnFor(null)).toBe(dailySnapshots.totalCostUsd)
  })

  it('falls back to the all-agent total for a name it does not recognize', () => {
    expect(costColumnFor('made-up-agent')).toBe(dailySnapshots.totalCostUsd)
  })
})

describe('monthToDateSpend', () => {
  it('coerces a numeric sum that arrives as a string', async () => {
    const { db } = fakeDb([], '123.45')
    const spend = await monthToDateSpend(db, ORG, null, null, DATE)
    expect(spend).toBe(123.45)
  })

  it('treats a null or unparseable sum as zero', async () => {
    const { db } = fakeDb([], null)
    expect(await monthToDateSpend(db, ORG, null, null, DATE)).toBe(0)
  })
})

describe('evaluateBudgetAlerts', () => {
  it('does nothing when the org/user has no alerts', async () => {
    const { db, updates } = fakeDb([], 0)
    await evaluateBudgetAlerts(db, ORG, USER, DATE)
    expect(updates).toHaveLength(0)
  })

  // The ticket's boundary case: a $100 limit at threshold 1 (100%) must trip
  // the instant spend reaches $100, not only after it passes it. Flipping the
  // service's `>=` to `>` makes this go red.
  it('trips when spend lands exactly on the trip point', async () => {
    const { db, updates } = fakeDb([alert({ monthlyLimitUsd: '100', threshold: '1' })], 100)
    await evaluateBudgetAlerts(db, ORG, USER, DATE)
    expect(updates).toHaveLength(1)
    expect(updates[0].trippedAt).toBeInstanceOf(Date)
  })

  it('does not trip one cent under the trip point', async () => {
    const { db, updates } = fakeDb([alert({ monthlyLimitUsd: '100', threshold: '1' })], 99.99)
    await evaluateBudgetAlerts(db, ORG, USER, DATE)
    expect(updates).toHaveLength(0)
  })

  it('trips when spend is past the trip point', async () => {
    const { db, updates } = fakeDb([alert({ monthlyLimitUsd: '100', threshold: '0.8' })], 85)
    await evaluateBudgetAlerts(db, ORG, USER, DATE)
    expect(updates).toHaveLength(1)
    expect(updates[0].trippedAt).toBeInstanceOf(Date)
  })

  it('does not re-write an alert already tripped this month', async () => {
    const trippedThisMonth = new Date(`${DATE.slice(0, 7)}-02T00:00:00Z`)
    const { db, updates } = fakeDb(
      [alert({ monthlyLimitUsd: '100', threshold: '1', trippedAt: trippedThisMonth })],
      150,
    )
    await evaluateBudgetAlerts(db, ORG, USER, DATE)
    expect(updates).toHaveLength(0)
  })

  it('clears a trip from this month when spend drops back under (limit raised)', async () => {
    const trippedThisMonth = new Date(`${DATE.slice(0, 7)}-02T00:00:00Z`)
    const { db, updates } = fakeDb(
      [alert({ monthlyLimitUsd: '500', threshold: '1', trippedAt: trippedThisMonth })],
      100,
    )
    await evaluateBudgetAlerts(db, ORG, USER, DATE)
    expect(updates).toHaveLength(1)
    expect(updates[0].trippedAt).toBeNull()
  })

  it('leaves an earlier month trip alone rather than overwriting it', async () => {
    const trippedLastMonth = new Date('2026-10-15T00:00:00Z')
    const { db, updates } = fakeDb(
      [alert({ monthlyLimitUsd: '100', threshold: '1', trippedAt: trippedLastMonth })],
      10,
    )
    await evaluateBudgetAlerts(db, ORG, USER, DATE)
    expect(updates).toHaveLength(0)
  })
})
