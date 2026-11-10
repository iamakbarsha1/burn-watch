import type { Document } from 'mongodb'
import type { AgentName } from '@burn-watch/shared'
import type { DailySnapshotDoc, UsageSource } from './documents.js'
import { dayKey, type IsoDate, type Micros, type OrgId, type UserId } from './ids.js'
import type { Store, Txn } from './store.js'

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

/**
 * Half-open [start, end) over the `date` field, which every snapshot stores as
 * a plain YYYY-MM-DD string. Kept as string arithmetic rather than Date
 * arithmetic so no timezone is ever consulted: `2026-11-30` and `2026-12-01`
 * are a month apart here whatever the server's offset is.
 */
function monthRange(date: IsoDate): [IsoDate, IsoDate] {
  const prefix = date.slice(0, 7)
  const [year, month] = prefix.split('-').map(Number)
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  return [`${prefix}-01` as IsoDate, `${nextYear}-${String(nextMonth).padStart(2, '0')}-01` as IsoDate]
}

/**
 * Which field of a snapshot an alert's scope sums: one agent's slot in
 * `byAgent`, or the all-agent total.
 *
 * Spelled out as five literal paths rather than built by interpolating the
 * agent name, and rather than reached through `$getField`. All three are the
 * same query; only this one cannot be handed a name that rewrites the path.
 * `agent` is read off a stored document, so TypeScript has vouched for nothing
 * about it, and a value carrying a dot or a leading `$` would otherwise point
 * the sum somewhere else entirely.
 *
 * `Record<AgentName, …>` rather than a loose map, so an agent added to the
 * shared union is a compile error here instead of an alert that silently
 * starts summing the all-agent total.
 *
 * An unrecognised name falls back to that total rather than to nothing, which
 * is what the Postgres `costColumnFor` did: a row written by an older build
 * still has to be priced against something real.
 */
const AGENT_COST_FIELD: Record<AgentName, string> = {
  claude: '$byAgent.claude.costMicros',
  qwen: '$byAgent.qwen.costMicros',
  gemini: '$byAgent.gemini.costMicros',
  codex: '$byAgent.codex.costMicros',
  copilot: '$byAgent.copilot.costMicros',
}

export function costFieldFor(agent: string | null): string {
  return (agent && AGENT_COST_FIELD[agent as AgentName]) || '$totalCostMicros'
}

/**
 * Month-to-date spend, in micros, for one scope: a whole org or one user of
 * it, and either one agent or every agent.
 *
 * Shared by the budget-alert evaluator and by the GET route that renders the
 * figure, so what an admin reads can never drift from what the last evaluation
 * decided against.
 */
export async function monthToDateSpend(
  store: Store,
  orgId: OrgId,
  userId: UserId | null,
  agent: string | null,
  date: IsoDate,
): Promise<Micros> {
  const [start, end] = monthRange(date)
  const match: Document = { orgId, date: { $gte: start, $lt: end } }
  if (userId) match.userId = userId

  const [row] = await store.dailySnapshots.aggregate<{ spend: number }>([
    { $match: match },
    { $group: { _id: null, spend: { $sum: costFieldFor(agent) } } },
  ])

  // `byAgent` is a partial map, so a day on which this agent did nothing has no
  // slot at all. `$sum` skips the missing path, which reads it as the zero it
  // is rather than dropping the whole document from the total. A scope with no
  // matching days produces no group row, and that is zero too.
  return (row?.spend ?? 0) as Micros
}
