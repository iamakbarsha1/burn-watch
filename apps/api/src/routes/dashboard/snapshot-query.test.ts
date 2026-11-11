import { describe, it, expect } from 'vitest'
import type { Document } from 'mongodb'
import type { IsoDate, OrgId } from '@burn-watch/db'
import { leaderboardPipeline } from './leaderboard.js'
import { trendsPipeline } from './trends.js'

/**
 * The stage-level net for the two `dailySnapshots` pipelines that had none.
 *
 * `overview-query.test.ts` covered overview and `enrichment-query.test.ts`
 * covered activity and projects; leaderboard and trends were read only through
 * a fake that answers from seeded rows and a live script that happened not to
 * assert on every accumulator. Mutation testing found the consequence: summing
 * `costMicros` where `tokens` belongs survived every layer, in both files, on
 * the per-agent token columns the leaderboard and the trends chart draw.
 *
 * Reading stages is not running them — `src/scripts/dashboard-pipelines.ts`
 * does that. What a stage assertion buys is the faults a fixture cannot be
 * relied on to expose: an accumulator reading its neighbour's field, and a
 * sort whose tie-break is never reached because no two rows in the fixture
 * tie.
 */
const ORG = 'ORG' as OrgId
const FROM = '2026-11-01' as IsoDate
const TO = '2026-11-05' as IsoDate

const leaderboard = leaderboardPipeline(ORG, FROM, TO, 50, 10)
const trends = trendsPipeline(ORG, FROM, TO)

const facetOf = (pipeline: Document[]): Record<string, Document[]> =>
  pipeline.find((stage) => '$facet' in stage)!.$facet

const stage = (branch: Document[], name: string): Document =>
  branch.find((s) => name in s)![name]

const indexOf = (branch: Document[], name: string) => branch.findIndex((s) => name in s)

describe.each([
  ['the leaderboard pipeline', () => leaderboard],
  ['the trends pipeline', () => trends],
])('%s', (_name, pipeline) => {
  it('opens by scoping to one organization and one date range', () => {
    expect(pipeline()[0]).toEqual({
      $match: { orgId: ORG, date: { $gte: FROM, $lte: TO } },
    })
  })

  it('keeps the per-agent rollup in its own facet branch', () => {
    // Unwinding `byAgent` before the totals multiplies each day's
    // `totalCostMicros` by the number of agents active that day. Two branches
    // is what keeps the two grains apart, and a single-branch rewrite would
    // still produce plausible, larger numbers.
    const branches = facetOf(pipeline())
    const totals = Object.values(branches).find((b) => b.some((s) => '$unwind' in s) === false)!
    expect(totals.some((s) => '$unwind' in s)).toBe(false)
  })

  it('treats a snapshot with no byAgent map as contributing nothing', () => {
    const agents = facetOf(pipeline()).agents
    expect(stage(agents, '$project').entries).toEqual({
      $objectToArray: { $ifNull: ['$byAgent', {}] },
    })
  })
})

describe('the leaderboard pipeline', () => {
  const branches = facetOf(leaderboard)

  it('sums each column from its own field', () => {
    // `tokens: {$sum: '$entries.v.costMicros'}` survived every behavioural
    // layer. The fixtures that would have caught it are the ones nobody wrote,
    // because every live assertion read a cost and none read a token.
    expect(stage(branches.users, '$group')).toEqual({
      _id: '$userId',
      totalCostMicros: { $sum: '$totalCostMicros' },
      totalTokens: { $sum: '$totalTokens' },
      sessions: { $sum: '$sessionCount' },
    })
    expect(stage(branches.agents, '$group')).toEqual({
      _id: { userId: '$userId', agent: '$entries.k' },
      tokens: { $sum: '$entries.v.tokens' },
      costMicros: { $sum: '$entries.v.costMicros' },
    })
  })

  it('ranks by spend descending, and breaks a tie on a stable key', () => {
    // Asserted as the whole sort spec rather than "a $sort exists". Removing
    // the tie-break cannot be caught by a fixture: two people on identical
    // spend come out of `$group` in whatever order the server chose, which is
    // as likely to be the sorted one as not. The comment at the sort explains
    // the page-boundary bug the second term fixes; this is what holds it.
    expect(stage(branches.users, '$sort')).toEqual({ totalCostMicros: -1, _id: 1 })
  })

  it('sorts before it pages, not after', () => {
    // `$skip`/`$limit` over an unsorted `$group` stream returns arbitrary
    // people in a plausible-looking order, and survives any fixture whose
    // insertion order happens to match its spend order.
    const users = branches.users
    expect(indexOf(users, '$sort')).toBeLessThan(indexOf(users, '$skip'))
    expect(indexOf(users, '$skip')).toBeLessThan(indexOf(users, '$limit'))
    expect(users.at(-2)).toEqual({ $skip: 10 })
    expect(users.at(-1)).toEqual({ $limit: 50 })
  })

  it('collects every person in range, so the integrity check is page-independent', () => {
    expect(stage(branches.everyone, '$group')).toEqual({
      _id: null,
      ids: { $addToSet: '$userId' },
    })
  })
})

describe('the trends pipeline', () => {
  const branches = facetOf(trends)

  it('sums each column from its own field', () => {
    expect(stage(branches.days, '$group')).toEqual({
      _id: '$date',
      totalCostMicros: { $sum: '$totalCostMicros' },
      totalTokens: { $sum: '$totalTokens' },
    })
    expect(stage(branches.agents, '$group')).toEqual({
      _id: { date: '$date', agent: '$entries.k' },
      tokens: { $sum: '$entries.v.tokens' },
      costMicros: { $sum: '$entries.v.costMicros' },
    })
  })

  it('sorts the days ascending, which the chart reads as the x axis', () => {
    // `$group` guarantees no ordering. A fixture whose buckets happen to come
    // back in date order passes with this stage deleted, and then one day does
    // not — a chart drawn backwards, from a change nothing touched.
    expect(stage(branches.days, '$sort')).toEqual({ _id: 1 })
    expect(indexOf(branches.days, '$group')).toBeLessThan(indexOf(branches.days, '$sort'))
  })
})
