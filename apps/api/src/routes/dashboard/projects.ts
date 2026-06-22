import type { FastifyInstance } from 'fastify'
import { eq, and, inArray } from 'drizzle-orm'
import { claudeEnrichment, users } from '../../../drizzle/schema.js'
import type { OrgProjectSummary, ProjectEntry } from '@burn-watch/shared'

export async function projectsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { date: string } }>(
    '/projects',
    async (request, reply) => {
      const orgId = request.user.orgId
      const { date } = request.query
      if (!date) {
        return reply.status(400).send({ error: 'date is required' })
      }

      const cacheKey = `bw:projects:${orgId}:${date}`
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
          projectBreakdown: claudeEnrichment.projectBreakdown,
        })
        .from(claudeEnrichment)
        .where(
          and(
            inArray(claudeEnrichment.userId, userIds),
            eq(claudeEnrichment.date, date),
          ),
        )

      // Merge project breakdowns across users
      const merged = new Map<
        string,
        { totalCost: number; totalSessions: number; userCount: number }
      >()

      for (const row of rows) {
        const projects = row.projectBreakdown as ProjectEntry[] | null
        if (!projects) continue
        for (const p of projects) {
          const existing = merged.get(p.path)
          if (existing) {
            existing.totalCost += p.cost
            existing.totalSessions += p.sessions
            existing.userCount++
          } else {
            merged.set(p.path, {
              totalCost: p.cost,
              totalSessions: p.sessions,
              userCount: 1,
            })
          }
        }
      }

      const result: OrgProjectSummary[] = Array.from(merged.entries()).map(
        ([path, data]) => ({
          path,
          totalCost: data.totalCost,
          totalSessions: data.totalSessions,
          avgCostPerSession:
            data.totalSessions > 0 ? data.totalCost / data.totalSessions : 0,
          userCount: data.userCount,
        }),
      )

      await fastify.redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
      return result
    },
  )
}
