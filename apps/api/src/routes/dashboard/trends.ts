import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { z } from 'zod'
import { getStore, usdFromMicros, type IsoDate, type Micros, type OrgId } from '@burn-watch/db'
import type { AgentName, TrendPoint } from '@burn-watch/shared'
import { dateRangeFields } from './query-schema.js'

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
  ...dateRangeFields,
}).refine(d => d.days || (d.from && d.to), { message: 'Provide days or from+to' })

/** One day's totals across every user in the org. `_id` is the date. */
interface DayTotals {
  _id: IsoDate
  totalCostMicros: Micros
  totalTokens: number
}

/** One (day, agent) pair, summed across every user in the org. */
interface AgentTotals {
  _id: { date: IsoDate; agent: string }
  tokens: number
  costMicros: Micros
}

interface TrendsFacet {
  days: DayTotals[]
  agents: AgentTotals[]
}

/**
 * One point per day that has any snapshot, with its per-agent split.
 *
 * Two `$facet` branches for the same reason the leaderboard uses two: unwinding
 * `byAgent` before the day totals would count each day's `totalCostMicros` once
 * per agent active that day.
 *
 * Days with no snapshot produce no point, exactly as the `group by date` did.
 * The chart draws the gap rather than a zero, which is the distinction between
 * "nobody worked" and "we have no data".
 */
export function trendsPipeline(orgId: OrgId, from: IsoDate, to: IsoDate): Document[] {
  return [
    { $match: { orgId, date: { $gte: from, $lte: to } } },
    {
      $facet: {
        days: [
          {
            $group: {
              _id: '$date',
              totalCostMicros: { $sum: '$totalCostMicros' },
              totalTokens: { $sum: '$totalTokens' },
            },
          },
          { $sort: { _id: 1 } },
        ],
        agents: [
          { $project: { date: 1, entries: { $objectToArray: { $ifNull: ['$byAgent', {}] } } } },
          { $unwind: '$entries' },
          {
            $group: {
              _id: { date: '$date', agent: '$entries.k' },
              tokens: { $sum: '$entries.v.tokens' },
              costMicros: { $sum: '$entries.v.costMicros' },
            },
          },
        ],
      },
    },
  ]
}

export async function trendsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/trends',
    async (request, reply) => {
      const orgId = request.user.orgId as OrgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }

      let fromDate: IsoDate
      let toDate: IsoDate
      if (parsed.data.from && parsed.data.to) {
        fromDate = parsed.data.from as IsoDate
        toDate = parsed.data.to as IsoDate
      } else {
        const days = parsed.data.days ?? 30
        const since = new Date()
        since.setDate(since.getDate() - days)
        fromDate = since.toISOString().slice(0, 10) as IsoDate
        toDate = new Date().toISOString().slice(0, 10) as IsoDate
      }

      const [facet] = await getStore().dailySnapshots.aggregate<TrendsFacet>(
        trendsPipeline(orgId, fromDate, toDate),
      )

      const spendByDay = new Map<string, Map<string, AgentTotals>>()
      for (const row of facet?.agents ?? []) {
        let perAgent = spendByDay.get(row._id.date)
        if (!perAgent) spendByDay.set(row._id.date, (perAgent = new Map()))
        perAgent.set(row._id.agent, row)
      }

      const result: TrendPoint[] = (facet?.days ?? []).map((day) => {
        const perAgent = spendByDay.get(day._id)
        const cost = (name: AgentName) => {
          const totals = perAgent?.get(name)
          return totals ? usdFromMicros(totals.costMicros) : 0
        }
        const tokens = (name: AgentName) => perAgent?.get(name)?.tokens ?? 0
        return {
          date: day._id,
          claudeCost: cost('claude'),
          qwenCost: cost('qwen'),
          geminiCost: cost('gemini'),
          codexCost: cost('codex'),
          copilotCost: cost('copilot'),
          totalCost: usdFromMicros(day.totalCostMicros),
          // Only two agents carry a token series on this chart, which is what
          // `TrendPoint` declares. The per-agent totals for the other three are
          // in the facet and simply have no field to go in.
          claudeTokens: tokens('claude'),
          qwenTokens: tokens('qwen'),
          totalTokens: day.totalTokens,
        }
      })

      return result
    },
  )
}
