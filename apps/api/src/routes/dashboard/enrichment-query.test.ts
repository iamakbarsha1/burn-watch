import { describe, it, expect } from 'vitest'
import type { Document } from 'mongodb'
import type { IsoDate, OrgId } from '@burn-watch/db'
import { toolUsageTotals } from './activity.js'
import { projectTotals } from './projects.js'

/**
 * BW-25 moved the enrichment merge out of node and into the database. The route
 * tests hand the fake store whatever rows they seeded and never see a pipeline,
 * so nothing there can tell an aggregate that sums from one that returns the
 * documents unmerged. These read the stages.
 *
 * Reading stages is not running them. A pipeline that groups on the wrong key
 * still has a `$group` with a `$sum` in it, and nothing here would notice.
 * `src/scripts/dashboard-pipelines.ts` runs all five against a real server and
 * checks the arithmetic, including the cross-org case these cannot reach: the
 * fake ignores filters, so seeding a second org into it proves nothing about
 * whether the `$match` keeps that org out.
 */
const range = { orgId: 'ORG' as OrgId, from: '2026-01-01' as IsoDate, to: '2026-11-05' as IsoDate }

const activity = toolUsageTotals(range)
const projects = projectTotals(range)

const stage = (pipeline: Document[], name: string): Document =>
  pipeline.find((s) => name in s)![name]

const count = (pipeline: Document[], name: string) =>
  pipeline.filter((s) => name in s).length

describe.each([
  ['the activity pipeline', () => activity, () => ({ $sort: { count: -1, tool: 1 } })],
  ['the projects pipeline', () => projects, () => ({ $sort: { totalCost: -1, path: 1 } })],
])('%s', (_name, pipeline, expectedSort) => {
  it('opens by scoping to one organization and one date range', () => {
    // First stage, not merely present: an indexed `$match` placed after an
    // `$unwind` still returns the right answer and scans the whole collection
    // to get there.
    expect(pipeline()[0]).toEqual({
      $match: { orgId: 'ORG', date: { $gte: '2026-01-01', $lte: '2026-11-05' } },
    })
  })

  it('reads orgId off the enrichment document rather than joining users', () => {
    // Postgres had no org column here and reached it through `users`, which is
    // the join every correlated subquery on the admin roster once rendered
    // against the wrong table. There is no join to render.
    expect(JSON.stringify(pipeline())).not.toContain('$lookup')
  })

  it('sorts on a full spec, tie-break included', () => {
    // The whole spec, not "a $sort exists". Removing a tie-break cannot be
    // caught by a fixture — two rows that tie come out of `$group` in whatever
    // order the server chose, as likely to be the sorted one as not — so the
    // term's presence has to be asserted where it is written.
    expect(pipeline().at(-1)).toEqual(expectedSort())
  })

  it('strips _id, which is the only thing keeping the group key off the wire', () => {
    // Both handlers pass the driver's documents to the serializer with no
    // field list of their own, so the generic parameter is an assertion and
    // this stage is the enforcement. Postgres had an explicit `select({...})`
    // that could not leak a column.
    const shaping = pipeline().filter((s) => '$project' in s).at(-1)!.$project
    expect(shaping._id).toBe(0)
  })
})

describe('the activity pipeline', () => {
  it('sums each tool in the database rather than returning one row per document', () => {
    expect(stage(activity, '$group')).toEqual({
      _id: { category: '$entries.category', tool: '$entries.tool' },
      count: { $sum: '$entries.count' },
    })
  })

  it('expands all three usage maps in one pass', () => {
    // One `$unwind` over a concatenation, not three passes over the collection.
    expect(count(activity, '$unwind')).toBe(1)
    const concat = stage(activity, '$project').entries.$concatArrays
    expect(concat).toHaveLength(3)
  })

  it('keeps the same key name separate across categories', () => {
    // `git` as a tool and `git` as a shell are two different counts, so the
    // group key has to carry the category as well as the name.
    expect(stage(activity, '$group')._id).toHaveProperty('category')
  })

  it('tags each entry with the category of the map it came from', () => {
    const concat = stage(activity, '$project').entries.$concatArrays as Document[]
    expect(concat.map((c) => c.$map.in.category)).toEqual(['tool', 'shell', 'mcp'])
    expect(concat.map((c) => c.$map.input.$objectToArray.$ifNull[0])).toEqual([
      '$toolUsage',
      '$shellUsage',
      '$mcpUsage',
    ])
  })

  it('treats a null or absent usage map as empty rather than failing the stage', () => {
    const concat = stage(activity, '$project').entries.$concatArrays as Document[]
    for (const c of concat) {
      expect(c.$map.input.$objectToArray.$ifNull[1]).toEqual({})
    }
  })
})

describe('the projects pipeline', () => {
  it('expands the breakdown array in the database', () => {
    expect(stage(projects, '$unwind')).toBe('$projectBreakdown')
  })

  it('drops a document whose breakdown is null, absent or empty', () => {
    // `$unwind` without `preserveNullAndEmptyArrays` does exactly that, which
    // is what the node merge and `coalesce(..., '[]')` both did. Spelling the
    // option out as a string stage is the whole assertion: a later edit to an
    // object form with the flag turned on would start inventing a project row
    // with an undefined path for every user-day that recorded none.
    expect(typeof stage(projects, '$unwind')).toBe('string')
  })

  it('sums cost and sessions per project in the database', () => {
    expect(stage(projects, '$group')).toMatchObject({
      _id: '$projectBreakdown.path',
      totalCost: { $sum: '$projectBreakdown.cost' },
      totalSessions: { $sum: '$projectBreakdown.sessions' },
    })
  })

  it('counts distinct people, not enrichment documents', () => {
    // There is one enrichment document per user per day, so counting them
    // counts user-days: one developer on one project for 63 days reported 63
    // people under a column headed "Users".
    expect(stage(projects, '$group').users).toEqual({ $addToSet: '$userId' })
    expect(Object.values(stage(projects, '$group'))).not.toContainEqual({ $sum: 1 })
    expect(stage(projects, '$project').userCount).toEqual({ $size: '$users' })
  })
})
