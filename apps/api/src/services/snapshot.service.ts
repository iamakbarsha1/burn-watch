import { eq, and, or, not, sum, sql } from 'drizzle-orm'
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

/**
 * Per-agent totals for one user-day, with one source winning per agent.
 *
 * Two sources write `usage_events` for the same developer. ccusage on their
 * machine reports every agent including Copilot, and a GitHub-org-level pull
 * reports Copilot for the whole org. Counting both doubles that developer's
 * Copilot spend, so exactly one source has to win, and the machine is the one
 * that knows which models and how many tokens.
 *
 * The pick happens here, at read time, rather than by skipping the write.
 * Write-time skipping only holds when the two sources arrive in one order:
 * ccusage syncing after the org pull, which is what a backfill does routinely,
 * would leave the org row already stored and the agent row discarded, or the
 * reverse, depending on which handler ran first. Preferring at read time gives
 * the same snapshot whatever order they landed in. It does not make the
 * snapshot follow deletes. Removing a usage_events row changes what this
 * aggregate returns but triggers no rebuild, so the stored day keeps its old
 * total until something rebuilds it. The cost is one window function per
 * rebuild.
 *
 * `bool_or(...) over (partition by agent)` is what makes the preference
 * per-agent. A developer can have agent-sourced claude and org-sourced copilot
 * on one day, and both have to count once. A single global "are there any
 * agent rows today" test would drop the copilot row entirely.
 *
 * Exported so the query test can render this exact statement. Lazy, so calling
 * it issues nothing until awaited.
 */
export function agentTotalsQuery(db: DbOrTx, userId: string, date: string) {
  const scoped = db
    .select({
      agent: usageEvents.agent,
      totalTokens: usageEvents.totalTokens,
      costUsd: usageEvents.costUsd,
      modelName: usageEvents.modelName,
      source: usageEvents.source,
      agentSourced: sql<boolean>`bool_or(${usageEvents.source} = 'agent') over (partition by ${usageEvents.agent})`
        .as('agent_sourced'),
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.date, date)))
    .as('scoped')

  return db
    .select({
      agent: scoped.agent,
      tokens: sum(scoped.totalTokens).mapWith(Number),
      cost: sum(scoped.costUsd).mapWith(Number),
      models: sql<string[]>`array_agg(distinct ${scoped.modelName})`,
    })
    .from(scoped)
    .where(or(eq(scoped.source, 'agent'), not(scoped.agentSourced)))
    .groupBy(scoped.agent)
}

export async function rebuildDailySnapshot(
  db: DbOrTx,
  userId: string,
  date: string,
): Promise<void> {
  // Two rebuilds of one user-day can overlap, since POST /v1/usage and the
  // Copilot org sync both land here. Without this lock both read usage_events
  // before either commits, and the later upsert overwrites the earlier one
  // with a total that never saw its rows. The row lock on daily_snapshots
  // serialises only the write, not the read that produced it.
  //
  // This works only under READ COMMITTED. The waiter takes a fresh snapshot
  // per statement, so once it holds the lock its aggregate sees the row the
  // previous holder committed. Under REPEATABLE READ the same lock would
  // still serialise the writes and still compute a stale total.
  //
  // Transaction-scoped on purpose. Production connects through Neon's pooler,
  // which is pgbouncer in transaction mode, and a session-scoped advisory lock
  // leaks across pooled clients there. The _xact_ variant releases at commit.
  //
  // hashtext can collide. A collision makes two unrelated rebuilds wait on
  // each other. It never changes what either of them writes.
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${userId} || ${date}))`)

  // 1. Aggregate usage_events by agent
  const agentRows = await agentTotalsQuery(db, userId, date)

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
