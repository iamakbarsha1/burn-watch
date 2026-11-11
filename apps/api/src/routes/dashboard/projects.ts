import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { getStore, type IsoDate, type OrgId } from '@burn-watch/db'
import type { OrgProjectSummary } from '@burn-watch/shared'
import { enrichmentMatch, type EnrichmentRange } from './enrichment.js'
import { dateQuerySchema as QuerySchema } from './query-schema.js'

/** One project, already folded across every user and day in range. */
export type ProjectTotals = Omit<OrgProjectSummary, 'avgCostPerSession'>

/**
 * Every project the org touched in range, with cost and sessions summed and the
 * number of distinct people who touched it.
 *
 * `$unwind` on `projectBreakdown` expands the array in the database rather than
 * in node, which drops the rows crossing the wire from users times days to
 * projects. A document whose breakdown is null, absent or empty is dropped by
 * `$unwind` and contributes nothing, which is what both the node merge and the
 * `coalesce(..., '[]')` it replaces did.
 *
 * `userCount` is `$addToSet` then `$size`, never a count of rows. There is one
 * enrichment document per user per day, so counting them counts user-days: one
 * developer on one project for 63 days reported 63 people under a column headed
 * "Users".
 *
 * The sort is new. A `$group` returns its buckets in no defined order, so
 * without it the table could reorder between two identical requests.
 *
 * Exported so `enrichment-query.test.ts` can read the stages. The route tests
 * seed the fake store's answer, so they never see this pipeline.
 */
export function projectTotals(range: EnrichmentRange): Document[] {
  return [
    enrichmentMatch(range),
    { $unwind: '$projectBreakdown' },
    {
      $group: {
        _id: '$projectBreakdown.path',
        totalCost: { $sum: '$projectBreakdown.cost' },
        totalSessions: { $sum: '$projectBreakdown.sessions' },
        users: { $addToSet: '$userId' },
      },
    },
    {
      $project: {
        _id: 0,
        path: '$_id',
        totalCost: 1,
        totalSessions: 1,
        userCount: { $size: '$users' },
      },
    },
    { $sort: { totalCost: -1, path: 1 } },
  ]
}

export async function projectsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/projects',
    async (request, reply) => {
      const orgId = request.user.orgId as OrgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }
      const from = (parsed.data.date ?? parsed.data.from!) as IsoDate
      const to = (parsed.data.date ?? parsed.data.to!) as IsoDate

      const rows = await getStore().claudeEnrichment.aggregate<ProjectTotals>(
        projectTotals({ orgId, from, to }),
      )

      // The one derived field, left in node because the guard is the point: a
      // project with recorded cost and no sessions must read 0, not Infinity or
      // NaN, and `$divide` by zero errors the whole stage rather than the row.
      const result: OrgProjectSummary[] = rows.map((row) => ({
        ...row,
        avgCostPerSession: row.totalSessions > 0 ? row.totalCost / row.totalSessions : 0,
      }))

      return result
    },
  )
}
