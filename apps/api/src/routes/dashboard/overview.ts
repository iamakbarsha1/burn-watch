import type { FastifyInstance } from 'fastify'
import { eq, and, sum, sql, countDistinct, gte, lte } from 'drizzle-orm'
import { dailySnapshots } from '../../../drizzle/schema.js'
import type { OverviewResponse, AgentSummary, AgentName } from '@burn-watch/shared'
import { dateQuerySchema as QuerySchema } from './query-schema.js'

export async function overviewRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/overview',
    async (request, reply) => {
      const orgId = request.user.orgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }
      const fromDate = parsed.data.date ?? parsed.data.from!
      const toDate = parsed.data.date ?? parsed.data.to!
      const isRange = fromDate !== toDate

      const [today] = await db_aggregate(fastify, orgId, fromDate, toDate)

      const todayCost = today?.totalCost ?? 0
      const todayTokens = today?.totalTokens ?? 0

      // Only compute delta for single-day views
      let vsYesterday: { costDelta: number; costPct: number; tokensDelta: number } | null = null
      if (!isRange) {
        const yesterday = new Date(fromDate)
        yesterday.setDate(yesterday.getDate() - 1)
        const yesterdayStr = yesterday.toISOString().slice(0, 10)
        const [yest] = await db_aggregate(fastify, orgId, yesterdayStr, yesterdayStr)
        const yesterdayCost = yest?.totalCost ?? 0
        const costDelta = todayCost - yesterdayCost
        vsYesterday = {
          costDelta,
          costPct: yesterdayCost > 0 ? (costDelta / yesterdayCost) * 100 : 0,
          tokensDelta: todayTokens - (yest?.totalTokens ?? 0),
        }
      }

      // Spelled out one agent at a time rather than building the column names
      // from the agent name. The string-built version needed two stacked
      // assertions, which turned the type checker off across the whole fan-out:
      // renaming a snapshot column compiled fine and returned undefined.
      const agentTotals: { agent: AgentName; tokens: number; costUsd: number }[] = [
        { agent: 'claude', tokens: today?.claudeTokens ?? 0, costUsd: today?.claudeCost ?? 0 },
        { agent: 'qwen', tokens: today?.qwenTokens ?? 0, costUsd: today?.qwenCost ?? 0 },
        { agent: 'gemini', tokens: today?.geminiTokens ?? 0, costUsd: today?.geminiCost ?? 0 },
        { agent: 'codex', tokens: today?.codexTokens ?? 0, costUsd: today?.codexCost ?? 0 },
        { agent: 'copilot', tokens: today?.copilotTokens ?? 0, costUsd: today?.copilotCost ?? 0 },
      ]
      const byAgent: AgentSummary[] = agentTotals.map((row) => ({
        ...row,
        isFreeTier: row.costUsd === 0,
      }))

      const result: OverviewResponse = {
        date: isRange ? `${fromDate} — ${toDate}` : fromDate,
        totalCostUsd: todayCost,
        totalTokens: todayTokens,
        activeUsers: today?.activeUsers ?? 0,
        vsYesterday: vsYesterday ?? { costDelta: 0, costPct: 0, tokensDelta: 0 },
        byAgent,
      }

      return result
    },
  )
}

async function db_aggregate(fastify: FastifyInstance, orgId: string, fromDate: string, toDate: string) {
  return fastify.db
    .select({
      totalCost: sum(dailySnapshots.totalCostUsd).mapWith(Number),
      totalTokens: sum(dailySnapshots.totalTokens).mapWith(Number),
      // daily_snapshots holds one row per user per day, so a plain count() here
      // counted rows and called them people: a single developer across 63 days
      // reported "63 active users" on a dashboard whose whole job is telling an
      // org how many of its developers are actually using AI.
      activeUsers: countDistinct(dailySnapshots.userId),
      claudeTokens: sum(dailySnapshots.claudeTokens).mapWith(Number),
      claudeCost: sum(dailySnapshots.claudeCostUsd).mapWith(Number),
      qwenTokens: sum(dailySnapshots.qwenTokens).mapWith(Number),
      qwenCost: sum(dailySnapshots.qwenCostUsd).mapWith(Number),
      geminiTokens: sum(dailySnapshots.geminiTokens).mapWith(Number),
      geminiCost: sum(dailySnapshots.geminiCostUsd).mapWith(Number),
      codexTokens: sum(dailySnapshots.codexTokens).mapWith(Number),
      codexCost: sum(dailySnapshots.codexCostUsd).mapWith(Number),
      copilotTokens: sum(dailySnapshots.copilotTokens).mapWith(Number),
      copilotCost: sum(dailySnapshots.copilotCostUsd).mapWith(Number),
    })
    .from(dailySnapshots)
    .where(and(eq(dailySnapshots.orgId, orgId), gte(dailySnapshots.date, fromDate), lte(dailySnapshots.date, toDate)))
}
