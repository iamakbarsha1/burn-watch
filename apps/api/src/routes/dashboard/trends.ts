import type { FastifyInstance } from 'fastify'
import { eq, and, gte, lte, sum, count } from 'drizzle-orm'
import { z } from 'zod'
import { dailySnapshots } from '../../../drizzle/schema.js'
import type { TrendPoint } from '@burn-watch/shared'

const dateRegex = /^\d{4}-\d{2}-\d{2}$/
const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
  from: z.string().regex(dateRegex).optional(),
  to: z.string().regex(dateRegex).optional(),
}).refine(d => d.days || (d.from && d.to), { message: 'Provide days or from+to' })

export async function trendsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/trends',
    async (request, reply) => {
      const orgId = request.user.orgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }

      let fromDate: string
      let toDate: string
      if (parsed.data.from && parsed.data.to) {
        fromDate = parsed.data.from
        toDate = parsed.data.to
      } else {
        const days = parsed.data.days ?? 30
        const since = new Date()
        since.setDate(since.getDate() - days)
        fromDate = since.toISOString().slice(0, 10)
        toDate = new Date().toISOString().slice(0, 10)
      }

      const cacheKey = `bw:trends:${orgId}:${fromDate}:${toDate}`
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
            gte(dailySnapshots.date, fromDate),
            lte(dailySnapshots.date, toDate),
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
