import { describe, it, expect } from 'vitest'
import type { Document } from 'mongodb'
import type { IsoDate, OrgId } from '@burn-watch/db'
import { dayBefore, overviewPipeline } from './overview.js'

/**
 * `activeUsers` counted rows, not people.
 *
 * dailySnapshots holds one document per user per day, so counting documents
 * over a range returns the number of user-days. One developer with 63 days of
 * history reported "63 active users" on the Overview page — on a dashboard
 * whose stated purpose is telling management how many developers actually use
 * AI.
 *
 * The route tests seed the fake store with the rows an aggregate answered, so
 * they never see the pipeline. These read the stages themselves. What they
 * cannot do is run them: proving that `$addToSet` plus `$size` really counts
 * distinct people needs a server, and that proof lives in
 * `src/scripts/dashboard-pipelines.ts`.
 */
const ORG = 'ORG' as OrgId
const FROM = '2026-11-01' as IsoDate
const TO = '2026-11-05' as IsoDate
const DAY = '2026-11-05' as IsoDate

const facetOf = (pipeline: Document[]): Record<string, Document[]> =>
  pipeline.find((stage) => '$facet' in stage)!.$facet

const groupIn = (branch: Document[]): Document =>
  branch.find((stage) => '$group' in stage)!.$group

describe('the overview pipeline', () => {
  const range = overviewPipeline(ORG, FROM, TO, null)
  const single = overviewPipeline(ORG, DAY, DAY, dayBefore(DAY))

  it('counts distinct developers, not snapshot rows', () => {
    expect(groupIn(facetOf(range).totals).users).toEqual({ $addToSet: '$userId' })
  })

  it('never falls back to counting documents for activeUsers', () => {
    // `{$sum: 1}` is the shape that reported 63 for one developer.
    const accumulators = Object.values(groupIn(facetOf(range).totals))
    expect(accumulators).not.toContainEqual({ $sum: 1 })
  })

  it('scopes every read to the caller organization', () => {
    expect(range[0]).toEqual({ $match: { orgId: ORG, date: { $gte: FROM, $lte: TO } } })
  })

  it('sums the per-agent split without naming an agent', () => {
    // Naming them meant five pairs of interpolated Postgres column names and
    // two stacked assertions, which turned the type checker off across the
    // whole fan-out.
    const stages = JSON.stringify(facetOf(range).byAgent)
    for (const agent of ['claude', 'qwen', 'gemini', 'codex', 'copilot']) {
      expect(stages).not.toContain(agent)
    }
    expect(groupIn(facetOf(range).byAgent)).toMatchObject({
      _id: '$entries.k',
      tokens: { $sum: '$entries.v.tokens' },
      costMicros: { $sum: '$entries.v.costMicros' },
    })
  })

  it('treats a snapshot with no byAgent map as contributing nothing', () => {
    const project = facetOf(range).byAgent.find((stage) => '$project' in stage)!.$project
    expect(project.entries).toEqual({ $objectToArray: { $ifNull: ['$byAgent', {}] } })
  })

  it('asks for no previous day on a range, where there is no yesterday', () => {
    expect(facetOf(range)).not.toHaveProperty('previous')
  })

  it('asks for the previous day on a single-day view', () => {
    expect(facetOf(single).previous[0]).toEqual({
      $match: { date: { $gte: '2026-11-04', $lte: '2026-11-04' } },
    })
  })

  it('widens the outer match to cover the previous day it is about to read', () => {
    // The branch filters are applied inside the `$facet`; a document the outer
    // `$match` excluded never reaches them, so yesterday would read zero and
    // every delta would equal today's spend.
    expect(single[0]).toEqual({
      $match: { orgId: ORG, date: { $gte: '2026-11-04', $lte: DAY } },
    })
  })
})

describe('dayBefore', () => {
  it('steps back one calendar day', () => {
    expect(dayBefore('2026-11-05' as IsoDate)).toBe('2026-11-04')
  })

  it('crosses a month boundary', () => {
    expect(dayBefore('2026-11-01' as IsoDate)).toBe('2026-10-31')
  })

  it('crosses a year boundary', () => {
    expect(dayBefore('2026-01-01' as IsoDate)).toBe('2025-12-31')
  })

  it('handles the leap day', () => {
    expect(dayBefore('2028-03-01' as IsoDate)).toBe('2028-02-29')
  })

  it('steps back across a DST transition, where the old local-clock step did not', () => {
    // 2026-03-29 is the European spring-forward. The version this replaces held
    // the local clock still and let the offset move underneath it, which lands
    // the resulting instant an hour either side of UTC midnight; these literal
    // expectations hold on any host because the arithmetic consults no offset.
    expect(dayBefore('2026-03-29' as IsoDate)).toBe('2026-03-28')
    expect(dayBefore('2026-03-30' as IsoDate)).toBe('2026-03-29')
    expect(dayBefore('2026-11-02' as IsoDate)).toBe('2026-11-01')
  })
})
