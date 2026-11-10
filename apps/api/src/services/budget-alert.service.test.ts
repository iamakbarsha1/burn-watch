import { describe, it, expect } from 'vitest'
import { COLLECTIONS } from '@burn-watch/db'
import type { BudgetAlertDoc, IsoDate, Micros, OrgId, UserId } from '@burn-watch/db'
import { callsTo, fakeStore, type MongoFakeState } from '../mongo-store.fake.js'
import { evaluateBudgetAlerts, evaluateBudgetAlert } from './budget-alert.service.js'

const ORG = 'org-1' as OrgId
const USER = 'user-1' as UserId
const DATE = '2026-11-05' as IsoDate

const alert = (over: Partial<BudgetAlertDoc> = {}): BudgetAlertDoc => ({
  _id: 'alert-1',
  orgId: ORG,
  userId: null,
  agent: null,
  monthlyLimitMicros: 100_000_000 as Micros,
  threshold: 1,
  trippedAt: null,
  createdAt: new Date('2026-01-01'),
  ...over,
})

/**
 * One alert per test, so an update in the recorded list unambiguously belongs
 * to it. `spend` is the figure the aggregation would have returned, in micros;
 * the pipeline that produces it is exercised in `packages/db`.
 */
function fake(alerts: BudgetAlertDoc[], spendMicros: number) {
  const state: MongoFakeState = {
    docs: { budgetAlerts: alerts },
    aggregates: { dailySnapshots: [{ _id: null, spend: spendMicros }] },
    calls: [],
    failOn: null,
    bulk: { upsertedCount: 0, matchedCount: 0 },
  }
  return {
    store: fakeStore(state, Object.keys(COLLECTIONS)),
    updates: () => callsTo(state, 'budgetAlerts', 'updateOne').map(([, update]) => update as { $set: Record<string, unknown> }),
    reads: () => callsTo(state, 'budgetAlerts', 'find').concat(callsTo(state, 'budgetAlerts', 'findOne')),
  }
}

const USD = 1_000_000

describe('evaluateBudgetAlerts', () => {
  it('does nothing when the org/user has no alerts', async () => {
    const { store, updates } = fake([], 0)
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    expect(updates()).toHaveLength(0)
  })

  it('reads only this org, and only alerts that cover this user', async () => {
    const { store, reads } = fake([], 0)
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    // An org-wide alert stores a null userId rather than omitting the field,
    // so the filter has to name it to match one.
    expect(reads()[0][0]).toEqual({ orgId: ORG, $or: [{ userId: null }, { userId: USER }] })
  })

  // The ticket's boundary case: a $100 limit at threshold 1 (100%) must trip
  // the instant spend reaches $100, not only after it passes it. Flipping the
  // service's `>=` to `>` makes this go red.
  it('trips when spend lands exactly on the trip point', async () => {
    const { store, updates } = fake([alert()], 100 * USD)
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    expect(updates()).toHaveLength(1)
    expect(updates()[0].$set.trippedAt).toBeInstanceOf(Date)
  })

  /**
   * The same boundary where the limit and the threshold do not multiply
   * cleanly. 55% of $10.50 is $5.775 to the micro, but `10_500_000 * 0.55`
   * evaluates to 5775000.000000001, so spend of exactly 5_775_000 micros
   * compared against the raw product is one ulp short and does not trip. An
   * inclusive boundary that holds only when the arithmetic happens to land
   * exactly is not an inclusive boundary.
   */
  it('trips on the boundary when limit times threshold is not exact', async () => {
    const { store, updates } = fake(
      [alert({ monthlyLimitMicros: 10_500_000 as Micros, threshold: 0.55 })],
      5_775_000,
    )
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    expect(updates()).toHaveLength(1)
    expect(updates()[0].$set.trippedAt).toBeInstanceOf(Date)
  })

  it('does not trip one micro under the trip point', async () => {
    const { store, updates } = fake([alert()], 100 * USD - 1)
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    expect(updates()).toHaveLength(0)
  })

  it('trips when spend is past the trip point', async () => {
    const { store, updates } = fake([alert({ threshold: 0.8 })], 85 * USD)
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    expect(updates()).toHaveLength(1)
    expect(updates()[0].$set.trippedAt).toBeInstanceOf(Date)
  })

  it('does not re-write an alert already tripped this month', async () => {
    const trippedThisMonth = new Date(`${DATE.slice(0, 7)}-02T00:00:00Z`)
    const { store, updates } = fake([alert({ trippedAt: trippedThisMonth })], 150 * USD)
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    expect(updates()).toHaveLength(0)
  })

  it('clears a trip from this month when spend drops back under (limit raised)', async () => {
    const trippedThisMonth = new Date(`${DATE.slice(0, 7)}-02T00:00:00Z`)
    const { store, updates } = fake(
      [alert({ monthlyLimitMicros: (500 * USD) as Micros, trippedAt: trippedThisMonth })],
      100 * USD,
    )
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    expect(updates()).toHaveLength(1)
    expect(updates()[0].$set.trippedAt).toBeNull()
  })

  it('leaves an earlier month trip alone rather than overwriting it', async () => {
    const trippedLastMonth = new Date('2026-10-15T00:00:00Z')
    const { store, updates } = fake([alert({ trippedAt: trippedLastMonth })], 10 * USD)
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    expect(updates()).toHaveLength(0)
  })
})

/**
 * The CRUD entry point. Without it the admin panel told an admin "OK" beside
 * a month-to-date figure already past the limit they had just typed, and kept
 * telling them that until the next agent sync ran the other evaluator.
 */
describe('evaluateBudgetAlert', () => {
  it('trips the single alert a create or update just wrote', async () => {
    const { store, updates } = fake(
      [alert({ monthlyLimitMicros: (400 * USD) as Micros, threshold: 0.5 })],
      554_220_000,
    )
    await evaluateBudgetAlert(store, ORG, 'alert-1', DATE)
    expect(updates()).toHaveLength(1)
    expect(updates()[0].$set.trippedAt).toBeInstanceOf(Date)
  })

  it('looks the alert up inside the caller org, never by id alone', async () => {
    const { store, reads } = fake([], 0)
    await evaluateBudgetAlert(store, ORG, 'alert-1', DATE)
    expect(reads()[0][0]).toEqual({ _id: 'alert-1', orgId: ORG })
  })

  it('clears a trip latched this month when the limit is raised past spend', async () => {
    const { store, updates } = fake(
      [
        alert({
          monthlyLimitMicros: (10_000 * USD) as Micros,
          threshold: 0.8,
          trippedAt: new Date(`${DATE}T09:00:00Z`),
        }),
      ],
      554_220_000,
    )
    await evaluateBudgetAlert(store, ORG, 'alert-1', DATE)
    expect(updates()).toHaveLength(1)
    expect(updates()[0].$set.trippedAt).toBeNull()
  })

  it('leaves an alert alone when it is already in the right state', async () => {
    const { store, updates } = fake(
      [alert({ monthlyLimitMicros: (10_000 * USD) as Micros, threshold: 0.8 })],
      554_220_000,
    )
    await evaluateBudgetAlert(store, ORG, 'alert-1', DATE)
    expect(updates()).toHaveLength(0)
  })

  it('is a no-op for an id that matches nothing in this org', async () => {
    const { store, updates } = fake([], 554_220_000)
    await evaluateBudgetAlert(store, ORG, 'does-not-exist', DATE)
    expect(updates()).toHaveLength(0)
  })
})
