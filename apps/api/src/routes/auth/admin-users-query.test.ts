import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/neon-serverless'
import { eq } from 'drizzle-orm'
import * as schema from '../../../drizzle/schema.js'
import { users } from '../../../drizzle/schema.js'
import { adminUserFields } from './device.js'

/**
 * The route tests hand the mocked driver whatever rows they queued, so they
 * cannot see the statement at all. This renders the real one.
 *
 * The bug this guards against: every correlated subquery came back 0 because
 * drizzle rendered the outer reference as a bare `"id"`, which the subquery's
 * own table captured. Nothing failed — the admin screen simply showed a team
 * with no devices, no spend and no sync dates.
 *
 * It has to be the whole statement. Rendering one field on its own qualifies
 * the columns and hides the bug; the prefixes are only stripped inside a
 * single-table select list, which is exactly where these subqueries live.
 */
// Never connects. The statement is built and rendered, never executed.
const db = drizzle({} as never, { schema })
const statement = new PgDialect().sqlToQuery(
  db.select(adminUserFields(db)).from(users).where(eq(users.orgId, 'ORG')).limit(500).getSQL(),
).sql

const occurrences = (needle: string) => statement.split(needle).length - 1

describe('the admin roster statement', () => {
  it('correlates all three device subqueries on the users row', () => {
    // count, hostnames, last seen.
    expect(occurrences('"devices"."user_id" = "users"."id"')).toBe(3)
  })

  it('correlates all four snapshot subqueries on the users row', () => {
    // last sync date, spend, tokens, active days.
    expect(occurrences('"daily_snapshots"."user_id" = "users"."id"')).toBe(4)
  })

  it('leaves no correlation reading a bare column', () => {
    // `where "user_id" = "id"` is the shape that silently resolved against the
    // subquery's own table and made every total zero.
    expect(statement).not.toMatch(/where\s+"user_id"\s*=/)
    expect(statement).not.toMatch(/=\s*"id"[\s)]/)
  })

  it('reads spend and tokens from snapshots and devices from devices', () => {
    expect(statement).toContain('sum("total_cost_usd")')
    expect(statement).toContain('sum("total_tokens")')
    expect(statement).toContain('count(*) from "devices"')
  })

  it('hands dates over as text so the driver cannot shift the day', () => {
    expect(statement).toContain('max("date")::text')
    expect(statement).toContain('to_char(max("last_seen_at")')
  })

  it('still scopes the roster to one organization', () => {
    expect(statement).toContain('"users"."org_id" = $1')
  })
})
