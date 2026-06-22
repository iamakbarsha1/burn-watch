import type { FastifyInstance } from 'fastify'
import { eq, and, gte, sum, count } from 'drizzle-orm'
import { dailySnapshots } from '../../../drizzle/schema.js'
import type { TrendPoint } from '@burn-watch/shared'

export async function trendsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { orgId: string; days?: string } }>(
    '/trends',
    async (request, reply) => {
      const { orgId, days: daysStr } = request.query
      if (!orgId) {
        return reply.status(400).send({ error: 'orgId is required' })
      }

      const days = Math.min(Number(daysStr) || 30, 90)
      const since = new Date()
      since.setDate(since.getDate() - days)
      const sinceStr = since.toISOString().slice(0, 10)

      const cacheKey = `bw:trends:${orgId}:${days}`
      const cached = await fastify.redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const rows = await fastify.db
        .select({
          date: dailySnapshots.date,
          claudeCost: sum(dailySnapshots.claudeCostUsd).mapWith(Number),
          qwenCost: sum(dailySnapshots.qwenCostUsd).mapWith(Number),
          geminiCost: sum(dailySnapshots.geminiCostUsd).mapWith(Number),
          codexCost: sum(dailySnapshots.codexCostUsd).mapWith(Number),
          copilotCost: sum(dailySnapshots.copilotCostUsd).mapWith(Number),
          totalCost: sum(dailySnapshots.totalCostUsd).mapWith(Number),
          claudeTokens: sum(dailySnapshots.claudeTokens).mapWith(Number),
          qwenTokens: sum(dailySnapshots.qwenTokens).mapWith(Number),
          totalTokens: sum(dailySnapshots.totalTokens).mapWith(Number),
        })
        .from(dailySnapshots)
        .where(
          and(
            eq(dailySnapshots.orgId, orgId),
            gte(dailySnapshots.date, sinceStr),
          ),
        )
        .groupBy(dailySnapshots.date)
        .orderBy(dailySnapshots.date)

      const result: TrendPoint[] = rows.map((r) => ({
        date: r.date,
        claudeCost: r.claudeCost ?? 0,
        qwenCost: r.qwenCost ?? 0,
        geminiCost: r.geminiCost ?? 0,
        codexCost: r.codexCost ?? 0,
        copilotCost: r.copilotCost ?? 0,
        totalCost: r.totalCost ?? 0,
        claudeTokens: r.claudeTokens ?? 0,
        qwenTokens: r.qwenTokens ?? 0,
        totalTokens: r.totalTokens ?? 0,
      }))

      await fastify.redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
      return result
    },
  )
}
