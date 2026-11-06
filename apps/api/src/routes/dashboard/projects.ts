import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { claudeEnrichment } from '../../../drizzle/schema.js'
import type { OrgProjectSummary, ProjectEntry } from '@burn-watch/shared'
import type { DB } from '../../plugins/db.js'
import { orgEnrichment, type EnrichmentRange } from './enrichment.js'

const dateRegex = /^\d{4}-\d{2}-\d{2}$/
const QuerySchema = z.object({
  date: z.string().regex(dateRegex).optional(),
  from: z.string().regex(dateRegex).optional(),
  to: z.string().regex(dateRegex).optional(),
}).refine(d => d.date || (d.from && d.to), { message: 'Provide date or from+to' })

type MergedEntry = Pick<ProjectEntry, 'path' | 'cost' | 'sessions'>

/**
 * One row per user: every project that user touched in range, with cost and
 * sessions already summed across their days. `jsonb_array_elements` unnests
 * the breakdown so the summing is a `group by` in postgres rather than a pass
 * over every row's JSONB in node, which drops the rows crossing the wire from
 * users times days to users.
 *
 * It stops at per-user rather than per-project because `userCount` is a count
 * of distinct people and the route still owns that merge. A null or absent
 * breakdown yields no rows, which is what the node merge did.
 *
 * Exported so `enrichment-query.test.ts` can render it. The route tests mock
 * the driver, so they never see this statement.
 */
export function projectTotalsPerUser(db: DB, range: EnrichmentRange) {
  const scoped = orgEnrichment(
    db,
    {
      userId: claudeEnrichment.userId,
      projectBreakdown: claudeEnrichment.projectBreakdown,
    },
    range,
  )

  return db
    .with(scoped)
    .select({
      userId: sql<string>`totals."userId"`,
      projectBreakdown: sql<MergedEntry[]>`jsonb_agg(jsonb_build_object('path', totals.path, 'cost', totals.cost, 'sessions', totals.sessions))`,
    })
    .from(sql`(
      select ${scoped.userId} as "userId",
             entry->>'path' as path,
             sum((entry->>'cost')::numeric) as cost,
             sum((entry->>'sessions')::numeric) as sessions
      from ${scoped}
      cross join lateral jsonb_array_elements(coalesce(${scoped.projectBreakdown}, '[]'::jsonb)) as entry
      group by ${scoped.userId}, entry->>'path'
    ) as totals`)
    .groupBy(sql`totals."userId"`)
}

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

      const rows = await projectTotalsPerUser(fastify.db, { orgId, from: fromDate, to: toDate })

      // Fold the per-user rows together. The aggregate already gives one row
      // per user, but contributors stay a set rather than a counter, because
      // counting rows is what reported one developer on one project for 63
      // days as 63 people.
      const merged = new Map<
        string,
        { totalCost: number; totalSessions: number; users: Set<string> }
      >()

      for (const row of rows) {
        const projects = row.projectBreakdown as MergedEntry[] | null
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
