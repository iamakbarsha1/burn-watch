import { eq, and, sql } from 'drizzle-orm'
import { usageEvents, claudeEnrichment } from '../../drizzle/schema.js'
import type { UsageEvent, ClaudeEnrichment } from '@burn-watch/shared'
import type { DbOrTx } from '../plugins/db.js'

/**
 * Who reported these rows. The device path stays the default, so an existing
 * caller that names no source keeps writing 'agent'.
 */
export type UsageSource = 'agent' | 'copilot-org'

export async function upsertUsageEvents(
  db: DbOrTx,
  userId: string,
  // Null for an org-level pull, which has no developer machine behind it. The
  // column is nullable for the same reason, and the unique constraint over it
  // is NULLS NOT DISTINCT so two such rows still collide instead of doubling.
  deviceId: string | null,
  date: string,
  events: UsageEvent[],
  source: UsageSource = 'agent',
): Promise<{ accepted: number; skipped: number }> {
  if (events.length === 0) return { accepted: 0, skipped: 0 }

  const rows = events.map((e) => ({
    userId,
    deviceId,
    source,
    agent: e.agent,
    date,
    modelName: e.modelName,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheCreateTokens: e.cacheCreateTokens,
    cacheReadTokens: e.cacheReadTokens,
    totalTokens: e.totalTokens,
    costUsd: String(e.costUsd),
    isFreeTier: e.isFreeTier,
  }))

  const result = await db
    .insert(usageEvents)
    .values(rows)
    // Must list every column of
    // `usage_events_unique_user_agent_date_model_device_source` or postgres
    // cannot infer an arbiter index and the insert errors instead of skipping
    // the duplicate.
    .onConflictDoNothing({
      target: [
        usageEvents.userId,
        usageEvents.agent,
        usageEvents.date,
        usageEvents.modelName,
        usageEvents.deviceId,
        usageEvents.source,
      ],
    })
    .returning({ id: usageEvents.id })

  const accepted = result.length
  return { accepted, skipped: events.length - accepted }
}

export async function upsertEnrichment(
  db: DbOrTx,
  userId: string,
  enrichment: ClaudeEnrichment,
): Promise<void> {
  await db
    .insert(claudeEnrichment)
    .values({
      userId,
      date: enrichment.date,
      sessionCount: enrichment.sessionCount,
      callCount: enrichment.callCount,
      cacheHitRate: String(enrichment.cacheHitRate),
      writtenTokens: enrichment.writtenTokens,
      activityBreakdown: enrichment.activityBreakdown,
      projectBreakdown: enrichment.projectBreakdown,
      topSessions: enrichment.topSessions,
      toolUsage: enrichment.toolUsage,
      shellUsage: enrichment.shellUsage,
      mcpUsage: enrichment.mcpUsage,
    })
    .onConflictDoUpdate({
      target: [claudeEnrichment.userId, claudeEnrichment.date],
      set: {
        sessionCount: sql`excluded.session_count`,
        callCount: sql`excluded.call_count`,
        cacheHitRate: sql`excluded.cache_hit_rate`,
        writtenTokens: sql`excluded.written_tokens`,
        activityBreakdown: sql`excluded.activity_breakdown`,
        projectBreakdown: sql`excluded.project_breakdown`,
        topSessions: sql`excluded.top_sessions`,
        toolUsage: sql`excluded.tool_usage`,
        shellUsage: sql`excluded.shell_usage`,
        mcpUsage: sql`excluded.mcp_usage`,
        submittedAt: sql`now()`,
      },
    })
}
