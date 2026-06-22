import type { FastifyInstance } from 'fastify'
import { eq, and, inArray } from 'drizzle-orm'
import { claudeEnrichment, users } from '../../../drizzle/schema.js'
import type { OrgActivitySummary, ActivityEntry } from '@burn-watch/shared'

export async function activityRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { orgId: string; date: string } }>(
    '/activity',
    async (request, reply) => {
      const { orgId, date } = request.query
      if (!orgId || !date) {
        return reply.status(400).send({ error: 'orgId and date are required' })
      }

      const cacheKey = `bw:activity:${orgId}:${date}`
      const cached = await fastify.redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      // Get org user IDs
      const orgUsers = await fastify.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.orgId, orgId))

      const userIds = orgUsers.map((u) => u.id)
      if (userIds.length === 0) {
        await fastify.redis.set(cacheKey, '[]', 'EX', 300)
        return []
      }

      const rows = await fastify.db
        .select({
          activityBreakdown: claudeEnrichment.activityBreakdown,
        })
        .from(claudeEnrichment)
        .where(
          and(
            inArray(claudeEnrichment.userId, userIds),
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
