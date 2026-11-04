import { eq, and, sum, sql } from 'drizzle-orm'
import {
  usageEvents,
  claudeEnrichment,
  dailySnapshots,
  users,
} from '../../drizzle/schema.js'
import type { DbOrTx } from '../plugins/db.js'

// `sum()` over a `numeric` column comes back as a string from postgres and is
// only turned into a number by the `.mapWith(Number)` below. Without a coercion
// here, a string slipping through would make `+` concatenate costs instead of
// adding them, and the day's total would be silently wrong rather than failing.
function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export async function rebuildDailySnapshot(
  db: DbOrTx,
  userId: string,
  date: string,
): Promise<void> {
  // 1. Aggregate usage_events by agent
  const agentRows = await db
    .select({
      agent: usageEvents.agent,
      tokens: sum(usageEvents.totalTokens).mapWith(Number),
      cost: sum(usageEvents.costUsd).mapWith(Number),
      models: sql<string[]>`array_agg(distinct ${usageEvents.modelName})`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.date, date)))
    .groupBy(usageEvents.agent)

  // Build per-agent maps
  const agentMap: Record<string, { tokens: number; cost: number }> = {}
  const allModels: string[] = []
  for (const row of agentRows) {
    agentMap[row.agent] = { tokens: toNumber(row.tokens), cost: toNumber(row.cost) }
    if (row.models) allModels.push(...row.models)
  }

  const get = (agent: string) => agentMap[agent] ?? { tokens: 0, cost: 0 }

  const totalTokens =
    get('claude').tokens +
    get('qwen').tokens +
    get('gemini').tokens +
    get('codex').tokens +
    get('copilot').tokens

  const totalCost =
    get('claude').cost +
    get('qwen').cost +
    get('gemini').cost +
    get('codex').cost +
    get('copilot').cost

  // 2. Get enrichment data
  const [enrichRow] = await db
    .select({
      sessionCount: claudeEnrichment.sessionCount,
      callCount: claudeEnrichment.callCount,
      cacheHitRate: claudeEnrichment.cacheHitRate,
    })
    .from(claudeEnrichment)
    .where(
      and(eq(claudeEnrichment.userId, userId), eq(claudeEnrichment.date, date)),
    )
    .limit(1)

  // 3. Get user's orgId
  const [user] = await db
    .select({ orgId: users.orgId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) return

  // 4. Upsert daily_snapshots
  await db
    .insert(dailySnapshots)
    .values({
      userId,
      orgId: user.orgId,
      date,
      claudeTokens: get('claude').tokens,
      claudeCostUsd: String(get('claude').cost),
      qwenTokens: get('qwen').tokens,
      qwenCostUsd: String(get('qwen').cost),
      geminiTokens: get('gemini').tokens,
      geminiCostUsd: String(get('gemini').cost),
      codexTokens: get('codex').tokens,
      codexCostUsd: String(get('codex').cost),
      copilotTokens: get('copilot').tokens,
      copilotCostUsd: String(get('copilot').cost),
      totalTokens,
      totalCostUsd: String(totalCost),
      callCount: enrichRow?.callCount ?? 0,
      sessionCount: enrichRow?.sessionCount ?? 0,
      cacheHitRate: enrichRow?.cacheHitRate ?? null,
      modelsUsed: [...new Set(allModels)],
    })
    .onConflictDoUpdate({
      target: [dailySnapshots.userId, dailySnapshots.date],
      set: {
        claudeTokens: sql`excluded.claude_tokens`,
        claudeCostUsd: sql`excluded.claude_cost_usd`,
        qwenTokens: sql`excluded.qwen_tokens`,
        qwenCostUsd: sql`excluded.qwen_cost_usd`,
        geminiTokens: sql`excluded.gemini_tokens`,
        geminiCostUsd: sql`excluded.gemini_cost_usd`,
        codexTokens: sql`excluded.codex_tokens`,
        codexCostUsd: sql`excluded.codex_cost_usd`,
        copilotTokens: sql`excluded.copilot_tokens`,
        copilotCostUsd: sql`excluded.copilot_cost_usd`,
        totalTokens: sql`excluded.total_tokens`,
        totalCostUsd: sql`excluded.total_cost_usd`,
        callCount: sql`excluded.call_count`,
        sessionCount: sql`excluded.session_count`,
        cacheHitRate: sql`excluded.cache_hit_rate`,
        modelsUsed: sql`excluded.models_used`,
        updatedAt: sql`now()`,
      },
    })
}
