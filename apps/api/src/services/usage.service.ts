import { eq, and, sql } from 'drizzle-orm'
import { usageEvents, claudeEnrichment } from '../../drizzle/schema.js'
import type { UsageEvent, ClaudeEnrichment } from '@burn-watch/shared'
import type { DB } from '../plugins/db.js'

export async function upsertUsageEvents(
  db: DB,
  userId: string,
  deviceId: string,
  date: string,
  events: UsageEvent[],
): Promise<{ accepted: number; skipped: number }> {
  if (events.length === 0) return { accepted: 0, skipped: 0 }

  const rows = events.map((e) => ({
    userId,
    deviceId,
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
    .onConflictDoNothing({
      target: [
        usageEvents.userId,
        usageEvents.agent,
        usageEvents.date,
        usageEvents.modelName,
        usageEvents.deviceId,
      ],
    })
    .returning({ id: usageEvents.id })

  const accepted = result.length
  return { accepted, skipped: events.length - accepted }
}

export async function upsertEnrichment(
  db: DB,
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
