import type { FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'
import { z } from 'zod'
import { claudeEnrichment, users } from '../../../drizzle/schema.js'
import type { OrgActivitySummary, ActivityEntry } from '@burn-watch/shared'

const QuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
})

export async function activityRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { date: string } }>(
    '/activity',
    async (request, reply) => {
      const orgId = request.user.orgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }
      const { date } = parsed.data

      const cacheKey = `bw:activity:${orgId}:${date}`
      const cached = await fastify.redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const rows = await fastify.db
        .select({
          activityBreakdown: claudeEnrichment.activityBreakdown,
        })
        .from(claudeEnrichment)
        .innerJoin(users, eq(claudeEnrichment.userId, users.id))
        .where(
          and(
            eq(users.orgId, orgId),
            eq(claudeEnrichment.date, date),
          ),
        )

      // Merge activity breakdowns across users
      const merged = new Map<
        string,
        { totalCost: number; totalTurns: number; oneShotRates: number[]; userCount: number }
      >()

      for (const row of rows) {
        const activities = row.activityBreakdown as ActivityEntry[] | null
        if (!activities) continue
        for (const a of activities) {
          const existing = merged.get(a.type)
          if (existing) {
            existing.totalCost += a.cost
            existing.totalTurns += a.turns
            existing.oneShotRates.push(a.oneShotRate)
            existing.userCount++
          } else {
            merged.set(a.type, {
              totalCost: a.cost,
              totalTurns: a.turns,
              oneShotRates: [a.oneShotRate],
              userCount: 1,
            })
          }
        }
      }

      const result: OrgActivitySummary[] = Array.from(merged.entries()).map(
        ([type, data]) => ({
          type,
          totalCost: data.totalCost,
          totalTurns: data.totalTurns,
          avgOneShotRate:
            data.oneShotRates.reduce((a, b) => a + b, 0) / data.oneShotRates.length,
          userCount: data.userCount,
        }),
      )

      await fastify.redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
      return result
    },
  )
}
