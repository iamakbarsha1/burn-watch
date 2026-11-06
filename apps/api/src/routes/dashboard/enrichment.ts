import { and, eq, gte, lte } from 'drizzle-orm'
import type { PgColumn, WithSubqueryWithSelection } from 'drizzle-orm/pg-core'
import { claudeEnrichment, users } from '../../../drizzle/schema.js'
import type { DB } from '../../plugins/db.js'

export interface EnrichmentRange {
  orgId: string
  from: string
  to: string
}

/**
 * The `claude_enrichment` rows one org wrote between two dates, as a CTE named
 * `scoped`. Both dashboard routes that read enrichment JSONB aggregate on top
 * of this, so the join and the org and date scoping are written once.
 *
 * The join and the filter go through the query builder rather than being
 * spelled out in a `sql` template. Drizzle renders a column without its table
 * prefix inside a single-table select list, and a predicate written inline in
 * a template inherits that, which is how every correlated subquery on the
 * admin roster once resolved against the wrong table and returned zero. See
 * `adminUserFields` in routes/auth/device.ts. Inside the CTE the prefixes
 * survive, and `enrichment-query.test.ts` renders both statements to check.
 *
 * The two assertions are the price of taking the columns as a parameter.
 * Drizzle's select type branches on whether its argument is `undefined`, and a
 * type parameter leaves that branch unresolved, which strips `.where` and
 * `.getSQL` off everything downstream. Handing the builder a concrete type and
 * restating the result keeps both assertions inside this function: callers
 * still get `scoped.toolUsage` checked against the schema, so renaming a
 * column is still a type error.
 */
export function orgEnrichment<T extends Record<string, PgColumn>>(
  db: DB,
  columns: T,
  { orgId, from, to }: EnrichmentRange,
): WithSubqueryWithSelection<T, 'scoped'> {
  return db.$with('scoped').as(
    db
      .select(columns as Record<string, PgColumn>)
      .from(claudeEnrichment)
      .innerJoin(users, eq(claudeEnrichment.userId, users.id))
      .where(
        and(
          eq(users.orgId, orgId),
          gte(claudeEnrichment.date, from),
          lte(claudeEnrichment.date, to),
        ),
      ),
  ) as WithSubqueryWithSelection<T, 'scoped'>
}
