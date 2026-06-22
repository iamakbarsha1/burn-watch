import type { FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'
import { z } from 'zod'
import { claudeEnrichment, users } from '../../../drizzle/schema.js'
import type { OrgProjectSummary, ProjectEntry } from '@burn-watch/shared'

const QuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
})

export async function projectsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { date: string } }>(
    '/projects',
    async (request, reply) => {
      const orgId = request.user.orgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }
      const { date } = parsed.data

      const cacheKey = `bw:projects:${orgId}:${date}`
      const cached = await fastify.redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const rows = await fastify.db
        .select({
          projectBreakdown: claudeEnrichment.projectBreakdown,
        })
        .from(claudeEnrichment)
        .innerJoin(users, eq(claudeEnrichment.userId, users.id))
        .where(
          and(
            eq(users.orgId, orgId),
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
