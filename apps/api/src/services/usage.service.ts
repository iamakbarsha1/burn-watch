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

  // Must list every column of
  // `usage_events_unique_user_agent_date_model_device_source` or postgres
  // cannot infer an arbiter index and the insert errors instead of resolving
  // the duplicate.
  const target = [
    usageEvents.userId,
    usageEvents.agent,
    usageEvents.date,
    usageEvents.modelName,
    usageEvents.deviceId,
    usageEvents.source,
  ]

  const insert = db.insert(usageEvents).values(rows)

  // The two sources want opposite things from a repeat.
  //
  // A device re-reporting a day it already sent is ccusage reading the same
  // local files again, so the first write is as good as the second and
  // ignoring it keeps a resubmission cheap.
  //
  // An org pull is not that. GitHub documents `ai_credits_used` as a metrics
  // signal rather than a billed total, so a day's figures can legitimately
  // change after it first becomes queryable, and the sync is admin-triggered
  // precisely so someone can run it again. Ignoring the repeat would make a
  // synced day permanently unrevisable, with the correction reported as
  // `skipped` and indistinguishable from a true no-op. The only way back
  // would be deleting rows by hand.
  const result =
    source === 'agent'
      ? await insert.onConflictDoNothing({ target }).returning({ id: usageEvents.id })
      : await insert
          .onConflictDoUpdate({
            target,
            set: {
              inputTokens: sql`excluded.input_tokens`,
              outputTokens: sql`excluded.output_tokens`,
              cacheCreateTokens: sql`excluded.cache_create_tokens`,
              cacheReadTokens: sql`excluded.cache_read_tokens`,
              totalTokens: sql`excluded.total_tokens`,
              costUsd: sql`excluded.cost_usd`,
              isFreeTier: sql`excluded.is_free_tier`,
              submittedAt: sql`now()`,
            },
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
