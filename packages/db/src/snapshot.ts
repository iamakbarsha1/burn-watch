import type { Document } from 'mongodb'
import type { AgentName } from '@burn-watch/shared'
import type { DailySnapshotDoc, UsageSource } from './documents.js'
import { dayKey, type IsoDate, type Micros, type OrgId, type UserId } from './ids.js'
import type { Txn } from './store.js'

export interface AgentSourceTotals {
  agent: AgentName
  source: UsageSource
  tokens: number
  costMicros: Micros
  models: string[]
}

export type AgentTotals = Omit<AgentSourceTotals, 'source'>

/** Per (agent, source) totals for one user-day. One row per pair. */
export function agentSourceTotalsPipeline(userId: UserId, date: IsoDate): Document[] {
  return [
    { $match: { userId, date } },
    {
      $group: {
        _id: { agent: '$agent', source: '$source' },
        tokens: { $sum: '$totalTokens' },
        costMicros: { $sum: '$costMicros' },
        models: { $addToSet: '$modelName' },
      },
    },
    { $project: { _id: 0, agent: '$_id.agent', source: '$_id.source', tokens: 1, costMicros: 1, models: 1 } },
  ]
}

/**
 * Earlier entry wins. Two sources report the same developer's Copilot spend
 * (ccusage on their machine and the org-level pull), and counting both doubles
 * it. The machine knows which models and how many tokens, so it wins.
 */
export const SOURCE_PRECEDENCE: readonly UsageSource[] = ['agent', 'copilot-org']

/**
 * One source wins per agent, decided at read time so the snapshot is the same
 * whichever order the sources landed in. Per agent, not globally: a developer
 * with agent-sourced claude and org-sourced copilot on one day must count both.
 */
export function pickWinningSource(rows: AgentSourceTotals[]): AgentTotals[] {
  const rank = (s: UsageSource) => SOURCE_PRECEDENCE.indexOf(s)
  const winner = new Map<AgentName, AgentSourceTotals>()
  for (const row of rows) {
    const held = winner.get(row.agent)
    if (!held || rank(row.source) < rank(held.source)) winner.set(row.agent, row)
  }
  return [...winner.values()].map(({ agent, tokens, costMicros, models }) => ({ agent, tokens, costMicros, models }))
}

/**
 * What a rebuild computes. The enrichment fields (callCount, sessionCount,
 * cacheHitRate) are not among them: a recompute of agent totals must never
 * overwrite a field it did not compute, and zero is a legitimate real value, so
 * a clobber would be invisible.
 */
export type SnapshotTotals = Omit<DailySnapshotDoc, 'callCount' | 'sessionCount' | 'cacheHitRate'>

/** Pure. The document the day should hold given what the reads returned. */
export function buildSnapshot(
  userId: UserId,
  orgId: OrgId,
  date: IsoDate,
  totals: AgentTotals[],
  now: Date,
): SnapshotTotals {
  const byAgent: DailySnapshotDoc['byAgent'] = {}
  const models = new Set<string>()
  let totalTokens = 0
  let totalCostMicros = 0
  for (const t of totals) {
    byAgent[t.agent] = { tokens: t.tokens, costMicros: t.costMicros }
    totalTokens += t.tokens
    totalCostMicros += t.costMicros
    for (const m of t.models) models.add(m)
  }
  return {
    _id: dayKey(userId, date),
    userId,
    orgId,
    date,
    byAgent,
    totalTokens,
    totalCostMicros: totalCostMicros as Micros,
    modelsUsed: [...models].sort(),
    updatedAt: now,
  }
}

/**
 * Recomputes one user-day's snapshot from usageEvents inside the caller's
 * transaction, so it sees the caller's own uncommitted event upserts.
 *
 * Two concurrent rebuilds of one day both write the same dailySnapshots _id.
 * MongoDB's MVCC lets only one commit; the other aborts with a write conflict
 * and runInTxn re-runs its whole body from a fresh snapshot that includes the
 * first's committed events. No lock document, no version field.
 */
export async function rebuildDailySnapshot(tx: Txn, userId: UserId, date: IsoDate): Promise<void> {
  const rows = await tx.usageEvents.aggregate<AgentSourceTotals>(agentSourceTotalsPipeline(userId, date))
  const user = await tx.users.findOne({ _id: userId }, { projection: { orgId: 1 } })
  if (!user) return
  const { _id, ...fields } = buildSnapshot(userId, user.orgId, date, pickWinningSource(rows), new Date())
  await tx.dailySnapshots.updateOne(
    { _id },
    { $set: fields, $setOnInsert: { callCount: 0, sessionCount: 0, cacheHitRate: null } },
    { upsert: true },
  )
}
