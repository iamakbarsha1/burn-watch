import type { FastifyInstance } from 'fastify'
import { eq, and, gte, lte } from 'drizzle-orm'
import { z } from 'zod'
import { claudeEnrichment, users } from '../../../drizzle/schema.js'
import type { OrgProjectSummary, ProjectEntry } from '@burn-watch/shared'

const dateRegex = /^\d{4}-\d{2}-\d{2}$/
const QuerySchema = z.object({
  date: z.string().regex(dateRegex).optional(),
  from: z.string().regex(dateRegex).optional(),
  to: z.string().regex(dateRegex).optional(),
}).refine(d => d.date || (d.from && d.to), { message: 'Provide date or from+to' })

export async function projectsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/projects',
    async (request, reply) => {
      const orgId = request.user.orgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }
      const fromDate = parsed.data.date ?? parsed.data.from!
      const toDate = parsed.data.date ?? parsed.data.to!

      const rows = await fastify.db
        .select({
          userId: claudeEnrichment.userId,
          projectBreakdown: claudeEnrichment.projectBreakdown,
        })
        .from(claudeEnrichment)
        .innerJoin(users, eq(claudeEnrichment.userId, users.id))
        .where(
          and(
            eq(users.orgId, orgId),
            gte(claudeEnrichment.date, fromDate),
            lte(claudeEnrichment.date, toDate),
          ),
        )

      // Merge project breakdowns across users. There is one row per user per
      // day, so contributors are collected into a set — counting rows would
      // report one developer on one project for 63 days as 63 people.
      const merged = new Map<
        string,
        { totalCost: number; totalSessions: number; users: Set<string> }
      >()

      for (const row of rows) {
        const projects = row.projectBreakdown as ProjectEntry[] | null
        if (!projects) continue
        for (const p of projects) {
          let entry = merged.get(p.path)
          if (!entry) {
            entry = { totalCost: 0, totalSessions: 0, users: new Set() }
            merged.set(p.path, entry)
          }
          entry.totalCost += p.cost
          entry.totalSessions += p.sessions
          entry.users.add(row.userId)
        }
      }

      const result: OrgProjectSummary[] = Array.from(merged.entries()).map(
        ([path, data]) => ({
          path,
          totalCost: data.totalCost,
          totalSessions: data.totalSessions,
          avgCostPerSession:
            data.totalSessions > 0 ? data.totalCost / data.totalSessions : 0,
          userCount: data.users.size,
        }),
      )

      return result
    },
  )
}
