import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { claudeEnrichment } from '../../../drizzle/schema.js'
import type { ToolUsageSummary } from '@burn-watch/shared'
import type { DB } from '../../plugins/db.js'
import { orgEnrichment, type EnrichmentRange } from './enrichment.js'
import { dateQuerySchema as QuerySchema } from './query-schema.js'

type UsageCounts = Record<string, number>

/**
 * The three usage objects, summed key by key across every enrichment row in
 * range, as a single row. The counting is a `group by` on `(category, key)`
 * rather than a pass over every row's JSONB in node, so the work scales with
 * the number of distinct tools rather than with users times days.
 *
 * `(values ...)` turns the three columns into three labelled rows so one
 * `jsonb_each_text` expands all of them, and the outer `filter` splits the
 * totals back into the per-category objects the route hands on. A column that
 * is null contributes nothing, which is what the node merge did.
 *
 * Exported so `enrichment-query.test.ts` can render it. The route tests mock
 * the driver, so they never see this statement.
 */
export function toolUsageTotals(db: DB, range: EnrichmentRange) {
  const scoped = orgEnrichment(
    db,
    {
      toolUsage: claudeEnrichment.toolUsage,
      shellUsage: claudeEnrichment.shellUsage,
      mcpUsage: claudeEnrichment.mcpUsage,
    },
    range,
  )

  const perCategory = (category: ToolUsageSummary['category']) =>
    sql<UsageCounts>`coalesce(jsonb_object_agg(totals.tool, totals.count) filter (where totals.category = ${category}), '{}'::jsonb)`

  return db
    .with(scoped)
    .select({
      toolUsage: perCategory('tool'),
      shellUsage: perCategory('shell'),
      mcpUsage: perCategory('mcp'),
    })
    .from(sql`(
      select cat.category, pair.key as tool, sum(pair.value::numeric) as count
      from ${scoped}
      cross join lateral (values
        ('tool', ${scoped.toolUsage}),
        ('shell', ${scoped.shellUsage}),
        ('mcp', ${scoped.mcpUsage})
      ) as cat(category, counts)
      cross join lateral jsonb_each_text(coalesce(cat.counts, '{}'::jsonb)) as pair
      group by cat.category, pair.key
    ) as totals`)
}

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

      const rows = await toolUsageTotals(fastify.db, { orgId, from: fromDate, to: toDate })

      // Flatten the per-category objects into the list the page renders. The
      // aggregate returns a single row, but the loop still adds across rows:
      // the merge characterization tests in routes.test.ts drive this through
      // a mocked driver that hands back one row per enrichment row.
      const tools = new Map<string, number>()
      const shells = new Map<string, number>()
      const mcps = new Map<string, number>()

      for (const row of rows) {
        for (const [k, v] of Object.entries(row.toolUsage ?? {})) {
          tools.set(k, (tools.get(k) ?? 0) + v)
        }
        for (const [k, v] of Object.entries(row.shellUsage ?? {})) {
          shells.set(k, (shells.get(k) ?? 0) + v)
        }
        for (const [k, v] of Object.entries(row.mcpUsage ?? {})) {
          mcps.set(k, (mcps.get(k) ?? 0) + v)
        }
      }

      const result: ToolUsageSummary[] = [
        ...Array.from(tools.entries()).map(([tool, count]) => ({ tool, count, category: 'tool' as const })),
        ...Array.from(shells.entries()).map(([tool, count]) => ({ tool, count, category: 'shell' as const })),
        ...Array.from(mcps.entries()).map(([tool, count]) => ({ tool, count, category: 'mcp' as const })),
      ]

      return result
    },
  )
}
