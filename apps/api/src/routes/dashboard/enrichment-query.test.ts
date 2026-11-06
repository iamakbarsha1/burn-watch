import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/neon-serverless'
import * as schema from '../../../drizzle/schema.js'
import { toolUsageTotals } from './activity.js'
import { projectTotalsPerUser } from './projects.js'

/**
 * BW-25 moved the enrichment JSONB merge out of node and into postgres. The
 * route tests hand the mocked driver whatever rows they queued and never see a
 * statement, so nothing there can tell an aggregate that sums from one that
 * silently returns the rows unmerged. This renders the real statements.
 *
 * It has to be the whole statement. Drizzle strips the table prefix off a
 * column inside a single-table select list, so rendering one field on its own
 * qualifies it and hides exactly the bug that once made every correlated
 * subquery on the admin roster read zero.
 */
// Never connects. The statements are built and rendered, never executed.
const db = drizzle({} as never, { schema })
const range = { orgId: 'ORG', from: '2026-01-01', to: '2026-11-05' }

const render = (query: { getSQL: () => never }) =>
  new PgDialect().sqlToQuery(query.getSQL()).sql

const activity = render(toolUsageTotals(db, range) as never)
const projects = render(projectTotalsPerUser(db, range) as never)

const occurrences = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1

describe.each([
  ['the activity aggregate', () => activity],
  ['the projects aggregate', () => projects],
])('%s', (_name, statement) => {
  it('joins enrichment to users with both table prefixes intact', () => {
    expect(statement()).toContain('"claude_enrichment"."user_id" = "users"."id"')
  })

  it('leaves no join predicate reading a bare column', () => {
    // `on "user_id" = "id"` is the shape that resolves against the wrong table
    // and quietly matches nothing.
    expect(statement()).not.toMatch(/on\s+"user_id"\s*=/)
  })

  it('scopes to one organization and one date range', () => {
    expect(statement()).toContain('"users"."org_id" = $1')
    expect(statement()).toContain('"claude_enrichment"."date" >= $2')
    expect(statement()).toContain('"claude_enrichment"."date" <= $3')
  })
})

describe('the activity aggregate', () => {
  it('unnests the usage objects in postgres', () => {
    expect(activity).toContain('jsonb_each_text')
  })

  it('sums each tool in postgres rather than returning one row per enrichment row', () => {
    expect(activity).toContain('sum(pair.value::numeric)')
    expect(activity).toContain('group by cat.category, pair.key')
  })

  it('splits the totals back into one object per category', () => {
    for (const category of ['tool', 'shell', 'mcp']) {
      expect(activity).toContain(
        `jsonb_object_agg(totals.tool, totals.count) filter (where totals.category = $`,
      )
      expect(activity).toContain(`'${category}', "scoped"."${category}_usage"`)
    }
  })

  it('reads each usage column once, inside the aggregate', () => {
    // Twice would mean the column also travels out unmerged.
    expect(occurrences(activity, '"scoped"."tool_usage"')).toBe(1)
    expect(occurrences(activity, '"scoped"."shell_usage"')).toBe(1)
    expect(occurrences(activity, '"scoped"."mcp_usage"')).toBe(1)
  })

  it('treats a null usage column as empty rather than dropping the row', () => {
    expect(activity).toContain(`coalesce(cat.counts, '{}'::jsonb)`)
  })
})

describe('the projects aggregate', () => {
  it('unnests the breakdown array in postgres', () => {
    expect(projects).toContain('jsonb_array_elements')
  })

  it('sums cost and sessions per project in postgres', () => {
    expect(projects).toContain(`sum((entry->>'cost')::numeric)`)
    expect(projects).toContain(`sum((entry->>'sessions')::numeric)`)
    expect(projects).toContain(`group by "scoped"."user_id", entry->>'path'`)
  })

  it('returns one row per user, so the route can still count distinct people', () => {
    expect(projects).toContain('group by totals."userId"')
    expect(projects).toContain('jsonb_agg(jsonb_build_object(')
  })

  it('reads the breakdown column once, inside the aggregate', () => {
    expect(occurrences(projects, '"scoped"."project_breakdown"')).toBe(1)
  })

  it('treats a null breakdown as empty rather than dropping the row', () => {
    expect(projects).toContain(`coalesce("scoped"."project_breakdown", '[]'::jsonb)`)
  })
})
