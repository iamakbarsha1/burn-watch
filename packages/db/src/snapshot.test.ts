import { describe, expect, it } from 'vitest'
import type { Document } from 'mongodb'
import { dayKey, type DeviceId, type IsoDate, type Micros, type OrgId, type UserId } from './ids.js'
import { buildSnapshot, pickWinningSource, rebuildDailySnapshot, type AgentSourceTotals } from './snapshot.js'
import type { Txn } from './store.js'
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
