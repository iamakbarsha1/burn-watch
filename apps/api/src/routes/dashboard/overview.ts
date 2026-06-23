import type { FastifyInstance } from 'fastify'
import { eq, and, sum, sql, count, gte, lte } from 'drizzle-orm'
import { z } from 'zod'
import { dailySnapshots } from '../../../drizzle/schema.js'
import type { OverviewResponse, AgentSummary, AgentName } from '@burn-watch/shared'

const dateRegex = /^\d{4}-\d{2}-\d{2}$/
const QuerySchema = z.object({
  date: z.string().regex(dateRegex).optional(),
  from: z.string().regex(dateRegex).optional(),
  to: z.string().regex(dateRegex).optional(),
}).refine(d => d.date || (d.from && d.to), { message: 'Provide date or from+to' })

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

      const cacheKey = `bw:overview:${orgId}:${fromDate}:${toDate}`
      const cached = await fastify.redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

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

      const agents: AgentName[] = ['claude', 'qwen', 'gemini', 'codex', 'copilot']
      const byAgent: AgentSummary[] = agents.map((agent) => ({
        agent,
        tokens: today?.[`${agent}Tokens` as keyof typeof today] as number ?? 0,
        costUsd: today?.[`${agent}Cost` as keyof typeof today] as number ?? 0,
        isFreeTier: (today?.[`${agent}Cost` as keyof typeof today] as number ?? 0) === 0,
      }))

      const result: OverviewResponse = {
        date: isRange ? `${fromDate} — ${toDate}` : fromDate,
        totalCostUsd: todayCost,
        totalTokens: todayTokens,
        activeUsers: today?.activeUsers ?? 0,
        vsYesterday: vsYesterday ?? { costDelta: 0, costPct: 0, tokensDelta: 0 },
        byAgent,
      }

      await fastify.redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
      return result
    },
  )
}

async function db_aggregate(fastify: FastifyInstance, orgId: string, fromDate: string, toDate: string) {
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
    .where(and(eq(dailySnapshots.orgId, orgId), gte(dailySnapshots.date, fromDate), lte(dailySnapshots.date, toDate)))
}
