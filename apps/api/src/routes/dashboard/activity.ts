import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { getStore, type IsoDate, type OrgId } from '@burn-watch/db'
import type { ToolUsageSummary } from '@burn-watch/shared'
import { enrichmentMatch, type EnrichmentRange } from './enrichment.js'
import { dateQuerySchema as QuerySchema } from './query-schema.js'

/** `toolUsage`, `shellUsage` and `mcpUsage` under the category each belongs to. */
const CATEGORIES: readonly { category: ToolUsageSummary['category']; path: string }[] = [
  { category: 'tool', path: '$toolUsage' },
  { category: 'shell', path: '$shellUsage' },
  { category: 'mcp', path: '$mcpUsage' },
]

/**
 * The three usage maps, summed key by key across every enrichment document in
 * range, as one row per (category, tool).
 *
 * The counting is a `$group` rather than a pass over every document's blobs in
 * node, so the work scales with the number of distinct tools rather than with
 * users times days — which is also what keeps the rows crossing the wire from
 * growing with the range.
 *
 * `$objectToArray` turns each map into `{k, v}` rows and `$concatArrays` stacks
 * the three labelled sets into one list, so a single `$unwind` expands all of
 * them. `$ifNull` is what makes an absent or null map contribute nothing
 * instead of failing the stage — the same meaning `coalesce(cat.counts, '{}')`
 * carried, and the same one the node merge's `?? {}` had.
 *
 * The sort is new. A `$group` returns its buckets in no defined order, so
 * without it the list could reorder between two identical requests. Most-used
 * first, ties broken by name.
 *
 * Exported so `enrichment-query.test.ts` can read the stages. The route tests
 * seed the fake store's answer, so they never see this pipeline.
 */
export function toolUsageTotals(range: EnrichmentRange): Document[] {
  return [
    enrichmentMatch(range),
    {
      $project: {
        entries: {
          $concatArrays: CATEGORIES.map(({ category, path }) => ({
            $map: {
              input: { $objectToArray: { $ifNull: [path, {}] } },
              as: 'pair',
              in: { category, tool: '$$pair.k', count: '$$pair.v' },
            },
          })),
        },
      },
    },
    { $unwind: '$entries' },
    {
      $group: {
        _id: { category: '$entries.category', tool: '$entries.tool' },
        count: { $sum: '$entries.count' },
      },
    },
    { $project: { _id: 0, tool: '$_id.tool', category: '$_id.category', count: 1 } },
    { $sort: { count: -1, tool: 1 } },
  ]
}

export async function activityRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/activity',
    async (request, reply) => {
      const orgId = request.user.orgId as OrgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }
      const from = (parsed.data.date ?? parsed.data.from!) as IsoDate
      const to = (parsed.data.date ?? parsed.data.to!) as IsoDate

      // The pipeline already produces `ToolUsageSummary` rows, so there is
      // nothing left for the handler to fold. The node-side merge it replaces
      // lived here because Postgres could not reach inside a JSONB column
      // without the lateral unnest in the statement below it.
      return await getStore().claudeEnrichment.aggregate<ToolUsageSummary>(
        toolUsageTotals({ orgId, from, to }),
      )
    },
  )
}
