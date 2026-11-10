import type { UsageEvent } from '@burn-watch/shared'
import type { UsageSource } from './documents.js'
import { microsFromUsd, type DeviceId, type IsoDate, type OrgId, type UserId } from './ids.js'
import type { Store } from './store.js'

/**
 * Upserts on the deterministic key {userId, date, agent, modelName, deviceId, source}.
 * deviceId is always named in the filter, never omitted, so the unique index
 * sees the null on org-sourced rows and two such rows collide.
 *
 * Neither tier can be an insertOne that ignores 11000: inside a transaction any
 * write error aborts the whole transaction, so "first write wins" is an upsert
 * that writes nothing on match.
 */
export async function upsertUsageEvents(
  store: Store,
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
  const r = await store.usageEvents.bulkWrite(ops)
  // agent: only an insert is an acceptance; a match is the skip the agent is told about.
  // copilot-org: every op lands, as ON CONFLICT DO UPDATE ... RETURNING returned every row.
  // matchedCount, not modifiedCount: a no-op re-sync still touches submittedAt.
  const accepted = source === 'agent' ? r.upsertedCount : r.upsertedCount + r.matchedCount
  return { accepted, skipped: events.length - accepted }
}
