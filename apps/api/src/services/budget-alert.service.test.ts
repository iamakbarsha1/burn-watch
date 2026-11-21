import { describe, it, expect } from 'vitest'
import { COLLECTIONS } from '@burn-watch/db'
import type { BudgetAlertDoc, IsoDate, Micros, OrgId, UserId } from '@burn-watch/db'
import { callsTo, fakeStore, type MongoFakeState } from '../mongo-store.fake.js'
import { evaluateBudgetAlerts, evaluateBudgetAlert, evaluateSeatAlerts } from './budget-alert.service.js'

const ORG = 'org-1' as OrgId
const USER = 'user-1' as UserId
const DATE = '2026-11-05' as IsoDate

const alert = (over: Partial<BudgetAlertDoc> = {}): BudgetAlertDoc => ({
  _id: 'alert-1',
  orgId: ORG,
  type: 'api-spend',
  userId: null,
  agent: null,
  monthlyLimitMicros: 100_000_000 as Micros,
  threshold: 1,
  idleDays: null,
  limitHits: null,
  trippedAt: null,
  createdAt: new Date('2026-01-01'),
  ...over,
})

/** What the per-user month aggregation answers: one user, all on claude. */
const monthRows = (micros: number) => [{ _id: USER, total: micros, claude: micros }]

/**
 * One alert per test, so an update in the recorded list unambiguously belongs
 * to it. `spend` is the figure the aggregation would have returned, in micros;
 * the pipeline that produces it is exercised in `packages/db`.
 */
function fake(alerts: BudgetAlertDoc[], spendMicros: number) {
  const state: MongoFakeState = {
    docs: { budgetAlerts: alerts },
    aggregates: { dailySnapshots: monthRows(spendMicros) },
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

  /**
   * The spend an alert is judged against has to be its own org's. The fake
   * answers the aggregation from a canned row, so this asserts the `$match`
   * the pipeline carries rather than the figure it returns — a dropped `orgId`
   * is invisible in the number and plain in the filter.
   */
  it('judges the alert against its own org-s spend and its own scope', async () => {
    const state: MongoFakeState = {
      docs: { budgetAlerts: [alert({ userId: USER, agent: 'claude' })] },
      aggregates: { dailySnapshots: monthRows(0) },
      calls: [],
      failOn: null,
      bulk: { upsertedCount: 0, matchedCount: 0 },
    }
    await evaluateBudgetAlerts(fakeStore(state, Object.keys(COLLECTIONS)), ORG, USER, DATE)

    const [pipeline] = callsTo(state, 'dailySnapshots', 'aggregate')[0] as [{ $match?: unknown }[]]
    expect(pipeline[0].$match).toMatchObject({ orgId: ORG, userId: USER })
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

describe('api-spend with seats', () => {
  it('does not count usage on a seated pair toward the limit', async () => {
    const state: MongoFakeState = {
      docs: { budgetAlerts: [alert()], seats: [{ _id: `${USER}:claude` }] },
      aggregates: { dailySnapshots: monthRows(150 * USD) },
      calls: [],
      failOn: null,
      bulk: { upsertedCount: 0, matchedCount: 0 },
    }
    await evaluateBudgetAlerts(fakeStore(state, Object.keys(COLLECTIONS)), ORG, USER, DATE)
    expect(callsTo(state, 'budgetAlerts', 'updateOne')).toHaveLength(0)
  })
})

/**
 * The fake ignores filters, so each case seeds what the real query would have
 * matched: seats come back as seeded, and the active-pairs aggregate answers
 * the seat keys that had tokens.
 */
function seatFake(over: Partial<BudgetAlertDoc>, seats: object[], active: string[]) {
  const state: MongoFakeState = {
    docs: { budgetAlerts: [alert({ type: 'idle-seat', idleDays: 14, ...over })], seats },
    aggregates: { dailySnapshots: active.map((_id) => ({ _id })) },
    calls: [],
    failOn: null,
    bulk: { upsertedCount: 0, matchedCount: 0 },
  }
  return { state, store: fakeStore(state, Object.keys(COLLECTIONS)) }
}

describe('idle-seat', () => {
  const seat = { _id: `${USER}:claude`, orgId: ORG, userId: USER, agent: 'claude', startDate: '2026-10-01' }

  it('trips when a seat had no tokens on its agent in the window', async () => {
    const { state, store } = seatFake({}, [seat], [])
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    const [, update] = callsTo(state, 'budgetAlerts', 'updateOne')[0] as [unknown, { $set: { trippedAt: unknown } }]
    expect(update.$set.trippedAt).toBeInstanceOf(Date)
  })

  it('stays quiet when the seat was used', async () => {
    const { state, store } = seatFake({}, [seat], [`${USER}:claude`])
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    expect(callsTo(state, 'budgetAlerts', 'updateOne')).toHaveLength(0)
  })

  it('ignores seats younger than idleDays, and reads a window of exactly idleDays', async () => {
    const { state, store } = seatFake({}, [], [])
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    // 14 days ending 2026-11-05 inclusive start on 2026-10-23.
    expect(callsTo(state, 'seats', 'find')[0][0]).toEqual({ orgId: ORG, startDate: { $lte: '2026-10-23' } })
    expect(callsTo(state, 'budgetAlerts', 'updateOne')).toHaveLength(0)
  })

  it('is re-checked by a seat write, along with api-spend but not limit-hit', async () => {
    const { state, store } = seatFake({}, [seat], [])
    await evaluateSeatAlerts(store, ORG, DATE)
    expect(callsTo(state, 'budgetAlerts', 'find')[0][0]).toEqual({ orgId: ORG, type: { $ne: 'limit-hit' } })
    expect(callsTo(state, 'budgetAlerts', 'updateOne')).toHaveLength(1)
  })
})

describe('limit-hit', () => {
  function hitFake(hits: object[]) {
    const state: MongoFakeState = {
      docs: { budgetAlerts: [alert({ type: 'limit-hit', limitHits: 3 })] },
      aggregates: { claudeEnrichment: hits },
      calls: [],
      failOn: null,
      bulk: { upsertedCount: 0, matchedCount: 0 },
    }
    return { state, store: fakeStore(state, Object.keys(COLLECTIONS)) }
  }

  it('trips when hits this month reach limitHits', async () => {
    const { state, store } = hitFake([{ _id: null, hits: 3 }])
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    expect(callsTo(state, 'budgetAlerts', 'updateOne')).toHaveLength(1)
  })

  it('does not trip one under', async () => {
    const { state, store } = hitFake([{ _id: null, hits: 2 }])
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    expect(callsTo(state, 'budgetAlerts', 'updateOne')).toHaveLength(0)
  })

  it('sums limitHitCount with $sum, which reads a null day as 0, over this month in the org', async () => {
    const { state, store } = hitFake([])
    await evaluateBudgetAlerts(store, ORG, USER, DATE)
    const [pipeline] = callsTo(state, 'claudeEnrichment', 'aggregate')[0] as [Record<string, unknown>[]]
    expect(pipeline).toEqual([
      { $match: { orgId: ORG, date: { $gte: '2026-11-01', $lt: '2026-12-01' } } },
      { $group: { _id: null, hits: { $sum: '$limitHitCount' } } },
    ])
    expect(callsTo(state, 'budgetAlerts', 'updateOne')).toHaveLength(0)
  })
})
