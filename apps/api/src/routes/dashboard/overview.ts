import type { FastifyInstance } from 'fastify'
import { eq, and, sum, sql, count } from 'drizzle-orm'
import { dailySnapshots } from '../../../drizzle/schema.js'
import type { OverviewResponse, AgentSummary, AgentName } from '@burn-watch/shared'

export async function overviewRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { date: string } }>(
    '/overview',
    async (request, reply) => {
      const orgId = request.user.orgId
      const { date } = request.query
      if (!date) {
        return reply.status(400).send({ error: 'date is required' })
      }

      // Check cache
      const cacheKey = `bw:overview:${orgId}:${date}`
      const cached = await fastify.redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      // Today's data
      const [today] = await db_aggregate(fastify, orgId, date)

      // Yesterday's data for delta
      const yesterday = new Date(date)
      yesterday.setDate(yesterday.getDate() - 1)
      const yesterdayStr = yesterday.toISOString().slice(0, 10)
      const [yest] = await db_aggregate(fastify, orgId, yesterdayStr)

      const todayCost = today?.totalCost ?? 0
      const todayTokens = today?.totalTokens ?? 0
      const yesterdayCost = yest?.totalCost ?? 0

      const costDelta = todayCost - yesterdayCost
      const costPct = yesterdayCost > 0 ? (costDelta / yesterdayCost) * 100 : 0
      const tokensDelta = todayTokens - (yest?.totalTokens ?? 0)

      const agents: AgentName[] = ['claude', 'qwen', 'gemini', 'codex', 'copilot']
      const byAgent: AgentSummary[] = agents.map((agent) => ({
        agent,
        tokens: today?.[`${agent}Tokens` as keyof typeof today] as number ?? 0,
        costUsd: today?.[`${agent}Cost` as keyof typeof today] as number ?? 0,
        isFreeTier: (today?.[`${agent}Cost` as keyof typeof today] as number ?? 0) === 0,
      }))

      const result: OverviewResponse = {
        date,
        totalCostUsd: todayCost,
        totalTokens: todayTokens,
        activeUsers: today?.activeUsers ?? 0,
        vsYesterday: { costDelta, costPct, tokensDelta },
        byAgent,
      }

      await fastify.redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
      return result
    },
  )
}

async function db_aggregate(fastify: FastifyInstance, orgId: string, date: string) {
  return fastify.db
    .select({
      totalCost: sum(dailySnapshots.totalCostUsd).mapWith(Number),
      totalTokens: sum(dailySnapshots.totalTokens).mapWith(Number),
      activeUsers: count(dailySnapshots.userId),
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
    .where(and(eq(dailySnapshots.orgId, orgId), eq(dailySnapshots.date, date)))
}
