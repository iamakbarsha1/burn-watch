import type { ClaudeEnrichment, UsageEvent } from '@burn-watch/shared'
import type { UsageSource } from './documents.js'
import {
  dayKey,
  microsFromUsd,
  type DeviceId,
  type IsoDate,
  type Micros,
  type OrgId,
  type UserId,
} from './ids.js'
import type { Txn } from './store.js'

/**
 * Upserts on the deterministic key {userId, date, agent, modelName, deviceId, source}.
 * deviceId is always named in the filter, never omitted. A filter without it
 * is unconstrained on deviceId, so a row from another device would match and
 * this device's write would be suppressed as a repeat.
 *
 * Neither tier can be an insertOne that ignores 11000: inside a transaction any
 * write error aborts the whole transaction, so "first write wins" is an upsert
 * that writes nothing on match.
 *
 * Takes a Txn, not a Store: the event upsert and the snapshot rebuild must share
 * one transaction, or the rebuild can run against events that are not yet
 * committed from its point of view, which is the BW-41 race.
 */
export async function upsertUsageEvents(
  tx: Txn,
  userId: UserId,
  orgId: OrgId,
  deviceId: DeviceId | null,
  date: IsoDate,
  events: UsageEvent[],
  source: UsageSource = 'agent',
): Promise<{ accepted: number; skipped: number }> {
  if (events.length === 0) return { accepted: 0, skipped: 0 }
  const now = new Date()
  const ops = events.map((e) => {
    const key = { userId, date, agent: e.agent, modelName: e.modelName, deviceId, source }
    const metrics = {
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheCreateTokens: e.cacheCreateTokens,
      cacheReadTokens: e.cacheReadTokens,
      totalTokens: e.totalTokens,
      costMicros: microsFromUsd(e.costUsd),
      isFreeTier: e.isFreeTier,
      submittedAt: now,
    }
    if (source === 'agent') {
      // A matched document is left exactly as it was: first write wins.
      return { updateOne: { filter: key, update: { $setOnInsert: { ...metrics, orgId } }, upsert: true } }
    }
    // A matched document takes the new figures: the org pull may carry corrections.
    return { updateOne: { filter: key, update: { $set: metrics, $setOnInsert: { orgId } }, upsert: true } }
  })
  const r = await tx.usageEvents.bulkWrite(ops)
  // agent: only an insert is an acceptance; a match is the skip the agent is told about.
  // copilot-org: every op lands, as ON CONFLICT DO UPDATE ... RETURNING returned every row.
  // matchedCount, not modifiedCount: a no-op re-sync still touches submittedAt.
  const accepted = source === 'agent' ? r.upsertedCount : r.upsertedCount + r.matchedCount
  return { accepted, skipped: events.length - accepted }
}

/**
 * Writes one user-day of Claude enrichment: the heavy blobs to
 * claudeEnrichment, and callCount, sessionCount and cacheHitRate to the
 * day's snapshot.
 *
 * Two writes rather than one, and the second is the whole reason this takes a
 * Txn. ClaudeEnrichmentDoc no longer carries those three counters — they live
 * only on DailySnapshotDoc, because rebuildDailySnapshot recomputes agent
 * totals and must not clobber a field it did not compute. Postgres had the
 * opposite arrangement: the counters lived on claude_enrichment and every
 * rebuild read them back out and copied them across. Nothing does that copy
 * now, so if this function only filled claudeEnrichment the dashboard would
 * read zeros for all three forever, and zero is a legitimate value for every
 * one of them, so nothing would ever raise.
 *
 * Each write $setOnInserts what the other one $sets. The two compose in either
 * order, and either one can be the write that creates the day, so neither has
 * to run first and neither leaves a half-formed snapshot behind.
 */
export async function upsertEnrichment(
  tx: Txn,
  userId: UserId,
  orgId: OrgId,
  enrichment: ClaudeEnrichment,
): Promise<void> {
  const date = enrichment.date as IsoDate
  const _id = dayKey(userId, date)
  const now = new Date()

  await tx.claudeEnrichment.updateOne(
    { _id },
    {
      $set: {
        userId,
        orgId,
        date,
        writtenTokens: enrichment.writtenTokens,
        activityBreakdown: enrichment.activityBreakdown,
        projectBreakdown: enrichment.projectBreakdown,
        topSessions: enrichment.topSessions,
        toolUsage: enrichment.toolUsage,
        shellUsage: enrichment.shellUsage,
        mcpUsage: enrichment.mcpUsage,
        submittedAt: now,
      },
    },
    { upsert: true },
  )

  await tx.dailySnapshots.updateOne(
    { _id },
    {
      $set: {
        callCount: enrichment.callCount,
        sessionCount: enrichment.sessionCount,
        cacheHitRate: enrichment.cacheHitRate,
      },
      $setOnInsert: {
        userId,
        orgId,
        date,
        byAgent: {},
        totalTokens: 0,
        totalCostMicros: 0 as Micros,
        modelsUsed: [],
        updatedAt: now,
      },
    },
    { upsert: true },
  )
}
