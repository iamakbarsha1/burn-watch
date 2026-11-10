import { sql } from 'drizzle-orm'
import type { DbOrTx } from './plugins/db.js'

/**
 * The `when` of the newest entry in `drizzle/migrations/meta/_journal.json`.
 *
 * Kept in sync by `schema-version.test.ts`, which reads the journal and fails
 * if this number drifts. A plain constant rather than an import of the journal
 * itself: the API ships as compiled output behind a plain Vercel function, and
 * a JSON file resolved at runtime is one more thing that has to survive the
 * bundle. A number cannot fail to deploy.
 */
export const EXPECTED_SCHEMA_VERSION = 1794298439254

/**
 * Rejects when the database is running behind the code talking to it.
 *
 * This exists because of BW-37. Migration 0004 added a column, nobody applied
 * it, and the only thing that knew was postgres — so `/health` answered 200
 * for 22 hours while every usage submission failed on the missing column. A
 * schema the code assumes and the database does not have is an outage, and an
 * outage should be visible to a monitor rather than to whoever clicks first.
 *
 * `drizzle.__drizzle_migrations` is drizzle's own bookkeeping table, so this
 * compares what the deployed code expects against what the database records as
 * applied. A missing table throws out of the query and counts as behind, which
 * is correct: a database that has never been migrated is exactly the state
 * this is here to catch.
 */
export async function assertSchemaCurrent(db: DbOrTx): Promise<void> {
  const result = await db.execute(
    sql`select coalesce(max(created_at), 0) as latest from drizzle.__drizzle_migrations`,
  )
  // The neon driver answers with a QueryResult; the route tests' fake answers
  // with a plain array. Both are read the same way rather than making the
  // tests model a driver shape they do not otherwise care about.
  const rows = (Array.isArray(result) ? result : result?.rows) as
    | { latest?: unknown }[]
    | undefined
  const latest = Number(rows?.[0]?.latest ?? 0)

  if (!Number.isFinite(latest) || latest < EXPECTED_SCHEMA_VERSION) {
    throw new Error(
      `Database schema is behind: recorded ${latest}, code expects ${EXPECTED_SCHEMA_VERSION}. ` +
        'Run `npm run db:migrate`.',
    )
  }
}
