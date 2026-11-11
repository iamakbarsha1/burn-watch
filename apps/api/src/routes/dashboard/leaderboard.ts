import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { z } from 'zod'
import { getStore, usdFromMicros, type IsoDate, type Micros, type OrgId, type UserId } from '@burn-watch/db'
import type { AgentName, LeaderboardEntry } from '@burn-watch/shared'
import { dateQueryShape } from './query-schema.js'

const QuerySchema = z.object({
  ...dateQueryShape,
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
}).refine(d => d.date || (d.from && d.to), { message: 'Provide date or from+to' })

/** One person's totals over the range. `_id` is the user id. */
interface UserTotals {
  _id: UserId
  totalCostMicros: Micros
  totalTokens: number
  sessions: number
}

/** One (user, agent) pair, summed over the range. */
interface AgentTotals {
  _id: { userId: UserId; agent: string }
  tokens: number
  costMicros: Micros
}

interface LeaderboardFacet {
  users: UserTotals[]
  agents: AgentTotals[]
}

const NO_SPEND = { tokens: 0, costUsd: 0 }

/**
 * The page of people, and the per-agent split for everyone in range, in one
 * round trip.
 *
 * Two `$facet` branches rather than one pipeline, because the two groupings
 * have different grains. Unwinding `byAgent` before the per-user totals would
 * duplicate each day's `totalCostMicros` once per agent that day and inflate
 * the column the ranking is sorted on.
 *
 * The agent branch is not narrowed to the page. It could be, at the cost of
 * either a second round trip or a `$lookup` back into the same collection; the
 * branch is bounded by the number of developers in one org, which is the
 * population this product exists to report on. If an org ever makes that
 * expensive, narrowing it is a `$match` on the ids the first branch returned.
 * ponytail: org-sized scan, narrow to the page if an org ever makes it hurt.
 *
 * Neither branch names an agent: `$objectToArray` turns the `byAgent` map into
 * rows and the `$group` sums whatever keys are present.
 */
export function leaderboardPipeline(
  orgId: OrgId,
  from: IsoDate,
  to: IsoDate,
  limit: number,
  offset: number,
): Document[] {
  return [
    { $match: { orgId, date: { $gte: from, $lte: to } } },
    {
      $facet: {
        users: [
          {
            $group: {
              _id: '$userId',
              totalCostMicros: { $sum: '$totalCostMicros' },
              totalTokens: { $sum: '$totalTokens' },
              sessions: { $sum: '$sessionCount' },
            },
          },
          // `_id` breaks ties so a page boundary is stable between requests.
          // Postgres ordered on the sum alone and two people on identical spend
          // could swap across pages, dropping one of them from both.
          { $sort: { totalCostMicros: -1, _id: 1 } },
          { $skip: offset },
          { $limit: limit },
        ],
        agents: [
          { $project: { userId: 1, entries: { $objectToArray: { $ifNull: ['$byAgent', {}] } } } },
          { $unwind: '$entries' },
          {
            $group: {
              _id: { userId: '$userId', agent: '$entries.k' },
              tokens: { $sum: '$entries.v.tokens' },
              costMicros: { $sum: '$entries.v.costMicros' },
            },
          },
        ],
      },
    },
  ]
}

export async function leaderboardRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/leaderboard',
    async (request, reply) => {
      const orgId = request.user.orgId as OrgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }
      const { limit, offset } = parsed.data
      const fromDate = (parsed.data.date ?? parsed.data.from!) as IsoDate
      const toDate = (parsed.data.date ?? parsed.data.to!) as IsoDate

      const store = getStore()
      const [facet] = await store.dailySnapshots.aggregate<LeaderboardFacet>(
        leaderboardPipeline(orgId, fromDate, toDate, limit, offset),
      )
      const page = facet?.users ?? []
      if (page.length === 0) return []

      // The `inner join users` the Postgres query opened with, as one lookup
      // for the page. Scoped to the caller's org as well as the id: the ids come
      // from snapshots already matched on `orgId`, so a snapshot whose user sits
      // in another org is corrupt rather than merely unusual, and resolving that
      // person's name into this response would be a cross-org leak.
      const ids = page.map((row) => row._id)
      const people = await store.users.find(
        { _id: { $in: ids }, orgId },
        { projection: { name: 1, email: 1 } },
      )
      const byId = new Map(people.map((user) => [user._id as string, user]))

      // Loud, not short. Postgres declared `daily_snapshots.user_id` NOT NULL
      // with a cascading foreign key, so a snapshot whose user was gone could
      // not exist and the inner join never dropped a row. MongoDB enforces no
      // such thing, so the same join silently drops the row instead — and a
      // leaderboard missing people is indistinguishable from an org where
      // nobody spent anything. On this branch, where `users` is not populated
      // until the Phase 7 backfill, that would render an empty page and call it
      // the truth.
      const missing = ids.filter((id) => !byId.has(id))
      if (missing.length > 0) {
        throw new Error(`leaderboard: no user document in ${orgId} for ${missing.join(', ')}`)
      }

      const spendByUser = new Map<string, Map<string, AgentTotals>>()
      for (const row of facet?.agents ?? []) {
        let perAgent = spendByUser.get(row._id.userId)
        if (!perAgent) spendByUser.set(row._id.userId, (perAgent = new Map()))
        perAgent.set(row._id.agent, row)
      }

      const result: LeaderboardEntry[] = page.map((row) => {
        const perAgent = spendByUser.get(row._id)
        const agent = (name: AgentName) => {
          const totals = perAgent?.get(name)
          if (!totals) return NO_SPEND
          return { tokens: totals.tokens, costUsd: usdFromMicros(totals.costMicros) }
        }
        const user = byId.get(row._id)!
        return {
          userId: row._id,
          name: user.name,
          email: user.email,
          claude: agent('claude'),
          qwen: agent('qwen'),
          gemini: agent('gemini'),
          codex: agent('codex'),
          copilot: agent('copilot'),
          totalCostUsd: usdFromMicros(row.totalCostMicros),
          totalTokens: row.totalTokens,
          sessions: row.sessions,
          // Carried over unchanged: the Postgres query selected a literal null
          // here. The per-day figure now lives on `DailySnapshotDoc.cacheHitRate`
          // and could be surfaced, but a mean of daily rates is not the rate
          // over the range, so turning it on is its own change with its own
          // decision about weighting.
          cacheHitRate: null,
        }
      })

      return result
    },
  )
}
