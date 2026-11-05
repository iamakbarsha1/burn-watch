import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/neon-serverless'
import { and, eq, gte, lte, sum, countDistinct } from 'drizzle-orm'
import * as schema from '../../../drizzle/schema.js'
import { dailySnapshots } from '../../../drizzle/schema.js'

/**
 * `activeUsers` counted rows, not people.
 *
 * daily_snapshots carries one row per user per day, so `count(user_id)` over a
 * range returns the number of user-days. One developer with 63 days of history
 * reported "63 active users" on the Overview page — on a dashboard whose stated
 * purpose is telling management how many developers actually use AI.
 *
 * The route tests feed the mocked driver canned rows, so they never see the
 * aggregate. This renders the real statement.
 */
// Never connects. The statement is built and rendered, never executed.
const db = drizzle({} as never, { schema })

const statement = new PgDialect().sqlToQuery(
  db
    .select({
      totalCost: sum(dailySnapshots.totalCostUsd).mapWith(Number),
      activeUsers: countDistinct(dailySnapshots.userId),
    })
    .from(dailySnapshots)
    .where(
      and(
        eq(dailySnapshots.orgId, 'ORG'),
        gte(dailySnapshots.date, '2026-01-01'),
        lte(dailySnapshots.date, '2026-11-05'),
      ),
    )
    .getSQL(),
).sql

describe('the overview aggregate', () => {
  // Drizzle drops the table prefix inside a single-table select list, so the
  // rendered column is a bare "user_id". That is unambiguous here — there is
  // only one table in the FROM — and it is what the assertions match.
  it('counts distinct developers, not snapshot rows', () => {
    expect(statement).toMatch(/count\(distinct\s+"user_id"\)/i)
  })

  it('never falls back to a plain row count on user_id', () => {
    // `count("user_id")` is the shape that reported 63 for one developer.
    expect(statement).not.toMatch(/count\(\s*"user_id"\s*\)/i)
  })
})
