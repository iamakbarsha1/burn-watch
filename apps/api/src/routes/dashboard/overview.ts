import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { getStore, usdFromMicros, type IsoDate, type Micros, type OrgId } from '@burn-watch/db'
import type { OverviewResponse, AgentSummary, AgentName } from '@burn-watch/shared'
import { dayBefore } from './dates.js'
import { dateQuerySchema as QuerySchema } from './query-schema.js'

/**
 * Every agent the response lists, in render order.
 *
 * `satisfies Record<AgentName, 0>` is doing the work the five spelled-out
 * column lists used to: an agent added to the shared union is a compile error
 * here, and a name that is not in the union is one too. The previous version
 * built the Postgres column names by interpolating the agent name, which needed
 * two stacked assertions and turned the type checker off across the whole
 * fan-out — renaming a snapshot column compiled fine and returned undefined.
 */
const AGENTS = Object.keys({
  claude: 0,
  qwen: 0,
  gemini: 0,
  codex: 0,
  copilot: 0,
} satisfies Record<AgentName, 0>) as AgentName[]

interface Totals {
  costMicros: Micros
  tokens: number
  activeUsers: number
}

/** One `byAgent` key, summed across the range. `_id` is the agent name. */
interface AgentRow {
  _id: string
  tokens: number
  costMicros: Micros
}

interface OverviewFacet {
  totals: Totals[]
  byAgent: AgentRow[]
  /** Absent unless the request asked for a single day. */
  previous?: Totals[]
}

const EMPTY: Totals = { costMicros: 0 as Micros, tokens: 0, activeUsers: 0 }

/**
 * One round trip for the whole page: the range's totals, its per-agent split,
 * and — for a single-day view — the previous day's totals for the delta.
 *
 * A `$facet` rather than two `aggregate` calls. The outer `$match` spans both
 * windows so `dailySnapshots_org_date` narrows the scan once, and each branch
 * re-filters the days it owns.
 *
 * The per-agent branch never names an agent. `byAgent` is a map on the
 * document, so `$objectToArray` turns it into rows and the `$group` sums
 * whatever keys are there — which is how ten hand-written per-agent column sums
 * become four lines that cannot fall out of step with the schema. An agent
 * written by an older build still totals correctly here; it is dropped at the
 * `AGENTS` map below, where Postgres' fixed columns dropped it too.
 */
export function overviewPipeline(
  orgId: OrgId,
  from: IsoDate,
  to: IsoDate,
  previous: IsoDate | null,
): Document[] {
  const span = (lo: IsoDate, hi: IsoDate): Document => ({ $match: { date: { $gte: lo, $lte: hi } } })

  const totals = (lo: IsoDate, hi: IsoDate): Document[] => [
    span(lo, hi),
    {
      $group: {
        _id: null,
        costMicros: { $sum: '$totalCostMicros' },
        tokens: { $sum: '$totalTokens' },
        // `$addToSet`, never `$sum: 1`. dailySnapshots holds one document per
        // user per day, so counting documents over a range counts user-days and
        // calls them people: one developer with 63 days of history reported
        // "63 active users" on the page whose stated job is telling an org how
        // many of its developers actually use AI.
        users: { $addToSet: '$userId' },
      },
    },
    { $project: { _id: 0, costMicros: 1, tokens: 1, activeUsers: { $size: '$users' } } },
  ]

  const facet: Document = {
    totals: totals(from, to),
    byAgent: [
      span(from, to),
      // `$ifNull` so a snapshot written before any agent reported still
      // contributes its row rather than erroring the stage.
      { $project: { entries: { $objectToArray: { $ifNull: ['$byAgent', {}] } } } },
      { $unwind: '$entries' },
      {
        $group: {
          _id: '$entries.k',
          tokens: { $sum: '$entries.v.tokens' },
          costMicros: { $sum: '$entries.v.costMicros' },
        },
      },
    ],
  }
  if (previous) facet.previous = totals(previous, previous)

  const start = previous && previous < from ? previous : from
  return [{ $match: { orgId, date: { $gte: start, $lte: to } } }, { $facet: facet }]
}

export async function overviewRoutes(fastify: FastifyInstance) {
  fastify.get('/overview', async (request, reply) => {
    const orgId = request.user.orgId as OrgId
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const fromDate = (parsed.data.date ?? parsed.data.from!) as IsoDate
    const toDate = (parsed.data.date ?? parsed.data.to!) as IsoDate
    const isRange = fromDate !== toDate

    // Only a single-day view carries a delta, as before. A range has no
    // "yesterday" that means anything.
    const previous = isRange ? null : dayBefore(fromDate)

    const [facet] = await getStore().dailySnapshots.aggregate<OverviewFacet>(
      overviewPipeline(orgId, fromDate, toDate, previous),
    )

    const current = facet?.totals[0] ?? EMPTY
    const todayCost = usdFromMicros(current.costMicros)
    const todayTokens = current.tokens

    let vsYesterday: { costDelta: number; costPct: number; tokensDelta: number } | null = null
    if (previous) {
      const yesterday = facet?.previous?.[0] ?? EMPTY
      // Subtracted in micros and divided in micros, converted once. Going to
      // dollars first reintroduces exactly the binary fractions the integer
      // encoding exists to avoid, and a percentage of two rounded floats is not
      // the percentage of the two figures the page prints above it.
      const deltaMicros = (current.costMicros - yesterday.costMicros) as Micros
      vsYesterday = {
        costDelta: usdFromMicros(deltaMicros),
        costPct: yesterday.costMicros > 0 ? (deltaMicros / yesterday.costMicros) * 100 : 0,
        tokensDelta: todayTokens - yesterday.tokens,
      }
    }

    const summed = new Map((facet?.byAgent ?? []).map((row) => [row._id, row]))
    const byAgent: AgentSummary[] = AGENTS.map((agent) => {
      const row = summed.get(agent)
      const costUsd = usdFromMicros((row?.costMicros ?? 0) as Micros)
      return { agent, tokens: row?.tokens ?? 0, costUsd, isFreeTier: costUsd === 0 }
    })

    const result: OverviewResponse = {
      date: isRange ? `${fromDate} — ${toDate}` : fromDate,
      totalCostUsd: todayCost,
      totalTokens: todayTokens,
      activeUsers: current.activeUsers,
      vsYesterday: vsYesterday ?? { costDelta: 0, costPct: 0, tokensDelta: 0 },
      byAgent,
    }

    return result
  })
}
