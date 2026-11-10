import { describe, expect, it } from 'vitest'
import type { Document } from 'mongodb'
import { dayKey, type DeviceId, type IsoDate, type Micros, type OrgId, type UserId } from './ids.js'
import type { DailySnapshotDoc } from './documents.js'
import {
  buildSnapshot,
  costFieldFor,
  monthToDateSpend,
  pickWinningSource,
  rebuildDailySnapshot,
  type AgentSourceTotals,
} from './snapshot.js'
import type { Store, Txn } from './store.js'
import { upsertUsageEvents } from './usage.js'

const row = (
  agent: AgentSourceTotals['agent'],
  source: AgentSourceTotals['source'],
  tokens: number,
  models: string[] = [],
): AgentSourceTotals => ({ agent, source, tokens, costMicros: (tokens * 10) as Micros, models })

const userId = 'u1' as UserId
const orgId = 'o1' as OrgId
const date = '2026-01-15' as IsoDate

describe('pickWinningSource', () => {
  it('prefers the agent source per agent, not globally', () => {
    // claude has only an agent row, copilot has both, codex has only the org
    // pull. A global "any agent rows today" test would drop codex entirely and
    // summing both sources would double copilot.
    const picked = pickWinningSource([
      row('claude', 'agent', 100),
      row('copilot', 'agent', 10),
      row('copilot', 'copilot-org', 999),
      row('codex', 'copilot-org', 5),
    ])
    expect(Object.fromEntries(picked.map((p) => [p.agent, p.tokens]))).toEqual({
      claude: 100,
      copilot: 10,
      codex: 5,
    })
  })

  it('is independent of the order rows arrive in', () => {
    const a = pickWinningSource([row('copilot', 'copilot-org', 999), row('copilot', 'agent', 10)])
    const b = pickWinningSource([row('copilot', 'agent', 10), row('copilot', 'copilot-org', 999)])
    expect(a).toEqual(b)
    expect(a[0].tokens).toBe(10)
  })
})

describe('buildSnapshot', () => {
  it('sums the winning rows and keys the document by user-day', () => {
    const now = new Date('2026-01-16T00:00:00Z')
    const doc = buildSnapshot(
      userId,
      orgId,
      date,
      [
        { agent: 'claude', tokens: 100, costMicros: 1_000_000 as Micros, models: ['opus', 'sonnet'] },
        { agent: 'codex', tokens: 5, costMicros: 50 as Micros, models: ['sonnet'] },
      ],
      now,
    )
    expect(doc._id).toBe(dayKey(userId, date))
    expect(doc.totalTokens).toBe(105)
    expect(doc.totalCostMicros).toBe(1_000_050)
    expect(doc.byAgent).toEqual({
      claude: { tokens: 100, costMicros: 1_000_000 },
      codex: { tokens: 5, costMicros: 50 },
    })
    expect(doc.modelsUsed).toEqual(['opus', 'sonnet'])
    expect(doc.updatedAt).toBe(now)
  })
})

/** A Txn that answers the three reads a rebuild makes and records its one write. */
function fakeTxn(rows: AgentSourceTotals[]) {
  const writes: Array<{ filter: Document; update: Document; opts: Document | undefined }> = []
  const tx = {
    usageEvents: { aggregate: async () => rows },
    users: { findOne: async () => ({ _id: userId, orgId }) },
    dailySnapshots: {
      updateOne: async (filter: Document, update: Document, opts?: Document) => {
        writes.push({ filter, update, opts })
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null }
      },
    },
  } as unknown as Txn
  return { tx, writes }
}

describe('rebuildDailySnapshot', () => {
  it('upserts the recomputed totals by user-day and never overwrites enrichment fields', async () => {
    const { tx, writes } = fakeTxn([row('claude', 'agent', 100, ['opus'])])
    await rebuildDailySnapshot(tx, userId, date)
    expect(writes).toHaveLength(1)
    const [{ filter, update, opts }] = writes
    expect(filter).toEqual({ _id: dayKey(userId, date) })
    expect(opts).toEqual({ upsert: true })
    expect(update.$set).toMatchObject({ userId, orgId, date, totalTokens: 100, modelsUsed: ['opus'] })
    // Zero is a real value for these, so a rebuild writing zeros would clobber
    // an enrichment that landed earlier with no visible error.
    for (const field of ['callCount', 'sessionCount', 'cacheHitRate']) {
      expect(update.$set).not.toHaveProperty(field)
    }
    expect(update.$setOnInsert).toEqual({ callCount: 0, sessionCount: 0, cacheHitRate: null })
  })
})

/** A Txn that records bulkWrite ops and reports a canned result. */
function fakeBulkTxn(result: { upsertedCount: number; matchedCount: number }) {
  let ops: Document[] = []
  const tx = {
    usageEvents: {
      bulkWrite: async (given: Document[]) => {
        ops = given
        return result
      },
    },
  } as unknown as Txn
  return { tx, ops: () => ops }
}

const wireEvent = {
  agent: 'claude' as const,
  date,
  modelName: 'opus',
  inputTokens: 1,
  outputTokens: 2,
  cacheCreateTokens: 3,
  cacheReadTokens: 4,
  totalTokens: 10,
  costUsd: 1.5,
  isFreeTier: false,
}

describe('upsertUsageEvents', () => {
  it('agent tier: first write wins, deviceId is always in the filter, only inserts count as accepted', async () => {
    const { tx, ops } = fakeBulkTxn({ upsertedCount: 1, matchedCount: 1 })
    const counts = await upsertUsageEvents(tx, userId, orgId, 'd1' as DeviceId, date, [wireEvent, wireEvent])
    const op = ops()[0].updateOne
    expect(op.filter).toEqual({ userId, date, agent: 'claude', modelName: 'opus', deviceId: 'd1', source: 'agent' })
    expect(op.upsert).toBe(true)
    expect(op.update.$setOnInsert).toMatchObject({ orgId, totalTokens: 10, costMicros: 1_500_000 })
    // A match must change nothing, so there is no $set at all.
    expect(op.update).not.toHaveProperty('$set')
    expect(counts).toEqual({ accepted: 1, skipped: 1 })
  })

  it('copilot-org tier: latest write wins, a null device is named in the filter, matches count as accepted', async () => {
    const { tx, ops } = fakeBulkTxn({ upsertedCount: 0, matchedCount: 1 })
    const counts = await upsertUsageEvents(tx, userId, orgId, null, date, [wireEvent], 'copilot-org')
    const op = ops()[0].updateOne
    // Omitting deviceId here would let any device's row match and swallow the write.
    expect(op.filter).toHaveProperty('deviceId', null)
    expect(op.filter.source).toBe('copilot-org')
    expect(op.update.$set).toMatchObject({ totalTokens: 10, costMicros: 1_500_000 })
    expect(op.update.$setOnInsert).toEqual({ orgId })
    // A no-op re-sync is still an acceptance (matchedCount, not modifiedCount).
    expect(counts).toEqual({ accepted: 1, skipped: 0 })
  })
})

describe('costFieldFor', () => {
  it('points at one agent slot of byAgent for a known agent', () => {
    expect(costFieldFor('claude')).toBe('$byAgent.claude.costMicros')
    expect(costFieldFor('qwen')).toBe('$byAgent.qwen.costMicros')
  })

  it('falls back to the all-agent total when no agent is named', () => {
    expect(costFieldFor(null)).toBe('$totalCostMicros')
  })

  it('falls back to the all-agent total for a name it does not recognise', () => {
    // `agent` is read off a stored document, so TypeScript has not vouched for
    // it. A row written by an older build must still be priced against a real
    // field, and no stored value may rewrite the path.
    expect(costFieldFor('made-up-agent')).toBe('$totalCostMicros')
    expect(costFieldFor('claude.costMicros')).toBe('$totalCostMicros')
    expect(costFieldFor('$where')).toBe('$totalCostMicros')
  })
})

const at = (path: string, doc: Document): unknown =>
  path.split('.').reduce<unknown>((v, k) => (v as Document | undefined)?.[k], doc)

/**
 * Just enough of `$match` and `$group` to run the one pipeline
 * `monthToDateSpend` builds, over documents held in an array.
 *
 * Strict on purpose: anything it was not written to understand throws instead
 * of being skipped. A condition added to the match — `$exists` on the agent
 * slot is the obvious one — would otherwise be silently ignored here while
 * quietly dropping whole days in production, which is the defect these cases
 * exist to catch.
 */
function evaluate(docs: Document[], pipeline: Document[]): Document[] {
  const [first, second, ...rest] = pipeline
  if (rest.length > 0 || !first?.$match || !second?.$group) {
    throw new Error(`unsupported pipeline: ${JSON.stringify(pipeline)}`)
  }

  const kept = docs.filter((doc) =>
    Object.entries(first.$match as Document).every(([field, want]) => {
      const have = at(field, doc)
      if (want === null || typeof want !== 'object') return have === want
      return Object.entries(want as Document).every(([op, bound]) => {
        if (op === '$gte') return (have as string) >= (bound as string)
        if (op === '$lt') return (have as string) < (bound as string)
        throw new Error(`unsupported $match operator: ${op}`)
      })
    }),
  )

  const { _id, ...accumulators } = second.$group as Document
  const sum = (accumulators.spend as Document | undefined)?.$sum
  if (_id !== null || Object.keys(accumulators).length !== 1 || typeof sum !== 'string') {
    throw new Error(`unsupported $group: ${JSON.stringify(second.$group)}`)
  }
  if (kept.length === 0) return []
  // $sum skips every value that is not a number, and an absent path is one.
  const spend = kept.reduce((total, doc) => {
    const value = at(sum.slice(1), doc)
    return total + (typeof value === 'number' ? value : 0)
  }, 0)
  return [{ _id: null, spend }]
}

const fakeStore = (docs: Document[]) =>
  ({ dailySnapshots: { aggregate: async (p: Document[]) => evaluate(docs, p) } }) as unknown as Store

const snapshot = (day: string, over: Partial<DailySnapshotDoc> = {}): Document => ({
  _id: dayKey(userId, day as IsoDate),
  userId,
  orgId,
  date: day,
  byAgent: {},
  totalTokens: 0,
  totalCostMicros: 0,
  callCount: 0,
  sessionCount: 0,
  cacheHitRate: null,
  modelsUsed: [],
  updatedAt: new Date(),
  ...over,
})

const NOV = '2026-11-20' as IsoDate

describe('monthToDateSpend', () => {
  it('sums the whole month to date for the org', async () => {
    const store = fakeStore([
      snapshot('2026-11-01', { totalCostMicros: 1_000_000 as Micros }),
      snapshot('2026-11-20', { totalCostMicros: 2_500_000 as Micros }),
    ])
    expect(await monthToDateSpend(store, orgId, null, null, NOV)).toBe(3_500_000)
  })

  it('takes the month half-open, so the first of the next month is out', async () => {
    const store = fakeStore([
      snapshot('2026-10-31', { totalCostMicros: 9_000_000 as Micros }),
      snapshot('2026-11-01', { totalCostMicros: 1_000_000 as Micros }),
      snapshot('2026-12-01', { totalCostMicros: 9_000_000 as Micros }),
    ])
    expect(await monthToDateSpend(store, orgId, null, null, NOV)).toBe(1_000_000)
  })

  it('rolls the year over at December without consulting a timezone', async () => {
    const store = fakeStore([
      snapshot('2026-12-31', { totalCostMicros: 4_000_000 as Micros }),
      snapshot('2027-01-01', { totalCostMicros: 9_000_000 as Micros }),
    ])
    expect(await monthToDateSpend(store, orgId, null, null, '2026-12-05' as IsoDate)).toBe(4_000_000)
  })

  it('narrows to one user when the alert is scoped to one', async () => {
    const store = fakeStore([
      snapshot('2026-11-02', { totalCostMicros: 1_000_000 as Micros }),
      snapshot('2026-11-03', { userId: 'u2' as UserId, totalCostMicros: 8_000_000 as Micros }),
    ])
    expect(await monthToDateSpend(store, orgId, userId, null, NOV)).toBe(1_000_000)
  })

  it('sums one agent slot rather than the total when the alert names an agent', async () => {
    const store = fakeStore([
      snapshot('2026-11-02', {
        byAgent: { claude: { tokens: 10, costMicros: 700_000 as Micros } },
        totalCostMicros: 900_000 as Micros,
      }),
    ])
    expect(await monthToDateSpend(store, orgId, null, 'claude', NOV)).toBe(700_000)
  })

  /**
   * `byAgent` is a partial map, so a day on which the named agent did nothing
   * carries no slot for it at all. That day has to read as zero and leave the
   * rest of the month standing. A match that required the slot to exist, or an
   * expression that treated a missing path as anything but zero, would drop
   * every other day with it and under-report the month.
   */
  it('reads a day with no slot for that agent as zero, not as a day to exclude', async () => {
    const store = fakeStore([
      snapshot('2026-11-02', { byAgent: { claude: { tokens: 10, costMicros: 700_000 as Micros } } }),
      snapshot('2026-11-03', { byAgent: { qwen: { tokens: 99, costMicros: 0 as Micros } } }),
      snapshot('2026-11-04', { byAgent: { claude: { tokens: 1, costMicros: 300_000 as Micros } } }),
    ])
    expect(await monthToDateSpend(store, orgId, null, 'claude', NOV)).toBe(1_000_000)
  })

  it('answers zero for an agent that appears on no day in the scope', async () => {
    const store = fakeStore([
      snapshot('2026-11-02', { byAgent: { claude: { tokens: 1, costMicros: 5 as Micros } } }),
    ])
    expect(await monthToDateSpend(store, orgId, null, 'gemini', NOV)).toBe(0)
  })

  it('answers zero rather than undefined when the scope has no days at all', async () => {
    expect(await monthToDateSpend(fakeStore([]), orgId, null, null, NOV)).toBe(0)
  })
})
