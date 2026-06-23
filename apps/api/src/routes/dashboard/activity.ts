import type { FastifyInstance } from 'fastify'
import { eq, and, gte, lte } from 'drizzle-orm'
import { z } from 'zod'
import { claudeEnrichment, users } from '../../../drizzle/schema.js'
import type { ToolUsageSummary } from '@burn-watch/shared'

const dateRegex = /^\d{4}-\d{2}-\d{2}$/
const QuerySchema = z.object({
  date: z.string().regex(dateRegex).optional(),
  from: z.string().regex(dateRegex).optional(),
  to: z.string().regex(dateRegex).optional(),
}).refine(d => d.date || (d.from && d.to), { message: 'Provide date or from+to' })

export async function activityRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/activity',
    async (request, reply) => {
      const orgId = request.user.orgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }
      const fromDate = parsed.data.date ?? parsed.data.from!
      const toDate = parsed.data.date ?? parsed.data.to!

      const cacheKey = `bw:activity:${orgId}:${fromDate}:${toDate}`
      const cached = await fastify.redis.get(cacheKey)
      if (cached) return JSON.parse(cached)

      const rows = await fastify.db
        .select({
          toolUsage: claudeEnrichment.toolUsage,
          shellUsage: claudeEnrichment.shellUsage,
          mcpUsage: claudeEnrichment.mcpUsage,
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

      // Merge counts across users per category
      const tools = new Map<string, number>()
      const shells = new Map<string, number>()
      const mcps = new Map<string, number>()

      for (const row of rows) {
        for (const [k, v] of Object.entries((row.toolUsage as Record<string, number>) ?? {})) {
          tools.set(k, (tools.get(k) ?? 0) + v)
        }
        for (const [k, v] of Object.entries((row.shellUsage as Record<string, number>) ?? {})) {
          shells.set(k, (shells.get(k) ?? 0) + v)
        }
        for (const [k, v] of Object.entries((row.mcpUsage as Record<string, number>) ?? {})) {
          mcps.set(k, (mcps.get(k) ?? 0) + v)
        }
      }

      const result: ToolUsageSummary[] = [
        ...Array.from(tools.entries()).map(([tool, count]) => ({ tool, count, category: 'tool' as const })),
        ...Array.from(shells.entries()).map(([tool, count]) => ({ tool, count, category: 'shell' as const })),
        ...Array.from(mcps.entries()).map(([tool, count]) => ({ tool, count, category: 'mcp' as const })),
      ]

      await fastify.redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
      return result
    },
  )
}
