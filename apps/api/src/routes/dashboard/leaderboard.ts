import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { z } from 'zod'
import {
  getStore,
  seatCost,
  seatKey,
  usdFromMicros,
  type IsoDate,
  type Micros,
  type OrgId,
  type UserId,
} from '@burn-watch/db'
import {
  HideOnLeaderboardSchema,
  LeaderboardSettingsSchema,
  type AgentName,
  type LeaderboardEntry,
  type LeaderboardSettings,
  type LeaderboardSettingsResponse,
  type LeaderboardSort,
  type Streak,
} from '@burn-watch/shared'
import { dateQueryShape, scopeError, teamIdField } from './query-schema.js'
import { readScope, requireAdmin } from '../../plugins/jwt.js'
import { audit, auditView } from '../../audit.js'
import { enrichmentMatch, type EnrichmentRange } from './enrichment.js'
import { today } from './dates.js'
import { streaks } from './streaks.js'

const SORTS = ['activeDays', 'score', 'streak', 'tokens', 'cost'] as const satisfies readonly LeaderboardSort[]

const QuerySchema = z.object({
  ...dateQueryShape,
  ...teamIdField,
  sort: z.enum(SORTS).default('activeDays'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
}).refine(d => d.date || (d.from && d.to), { message: 'Provide date or from+to' })

/** Score weights, in percent. Named on the page under the table. */
export const SCORE_WEIGHTS = { activeDays: 40, streak: 30, tokens: 20, features: 10 } as const

export const DEFAULT_LEADERBOARD: LeaderboardSettings = { developerView: 'own', showNames: true, showOthersCost: false }

/** One person's totals over the range. `_id` is the user id. */
interface UserTotals {
  _id: UserId
  totalCostMicros: Micros
  totalTokens: number
  sessions: number
  activeDays: number
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
  /** Everyone in range, not only the page. One row, or none for an empty range. */
  everyone: { ids: UserId[] }[]
}

/** Built per slot, never shared. A single frozen literal handed to every
 * zero-spend agent of every row is one object the whole response aliases, and
 * anything that later edits a row in place would edit all of them. */
const noSpend = () => ({ tokens: 0, costUsd: 0 })

/**
 * Everyone in range ranked by active days, and the per-agent split, in one
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
 *
 * No `$skip`/`$limit`: score, shared rank and the streak sort need every row
 * in scope, so the route ranks and pages in node.
 * shortcut: every row in scope is read per request, fine at org size; page in
 * the DB for the activeDays and tokens sorts if an org ever makes it slow.
 */
export function leaderboardPipeline(orgId: OrgId, from: IsoDate, to: IsoDate, userIds?: UserId[]): Document[] {
  return [
    { $match: { orgId, ...(userIds && { userId: { $in: userIds } }), date: { $gte: from, $lte: to } } },
    {
      $facet: {
        users: [
          {
            $group: {
              _id: '$userId',
              totalCostMicros: { $sum: '$totalCostMicros' },
              totalTokens: { $sum: '$totalTokens' },
              sessions: { $sum: '$sessionCount' },
              // Same active-day rule as A1 and A3: any tokens that day.
              activeDays: { $sum: { $cond: [{ $gt: ['$totalTokens', 0] }, 1, 0] } },
            },
          },
          { $match: { activeDays: { $gt: 0 } } },
          // `_id` breaks ties so a page boundary is stable between requests.
          // Postgres ordered on the sum alone and two people on identical spend
          // could swap across pages, dropping one of them from both.
          { $sort: { activeDays: -1, totalTokens: -1, _id: 1 } },
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
        // Everyone in range, so the integrity check below does not depend on
        // which page was asked for. Postgres joined `users` before LIMIT, so an
        // unresolvable row affected every page the same way; doing the lookup
        // on the page alone would make an orphan on page 0 fail page 0 and
        // leave page 1 answering 200, which is a failure that moves when you
        // look at it.
        everyone: [{ $group: { _id: null, ids: { $addToSet: '$userId' } } }],
      },
    },
  ]
}

/**
 * Distinct MCP server keys per person in range, for "features tried". Built
 * like `toolUsageTotals`, grouped by user instead of summed for the org.
 */
export function mcpServersPipeline(range: EnrichmentRange): Document[] {
  return [
    enrichmentMatch(range),
    { $project: { userId: 1, keys: { $map: { input: { $objectToArray: { $ifNull: ['$mcpUsage', {}] } }, in: '$$this.k' } } } },
    { $unwind: '$keys' },
    { $group: { _id: '$userId', servers: { $addToSet: '$keys' } } },
  ]
}

/** The org's leaderboard settings, defaults filled in. */
async function leaderboardSettings(orgId: OrgId): Promise<LeaderboardSettings> {
  const org = await getStore().organizations.findOne({ _id: orgId }, { projection: { leaderboard: 1 } })
  return { ...DEFAULT_LEADERBOARD, ...org?.leaderboard }
}

/** `value / top`, 0 when nobody has any. */
const share = (value: number, top: number) => (top > 0 ? value / top : 0)

export interface ScoreParts {
  activeDays: number
  /** Current streak. */
  streak: number
  tokens: number
  /** Agents used plus MCP servers tried. */
  features: number
}

/** The A8 score: each part against the top person in the same set. A6 ranks by it too. */
export function scoreAll(parts: ScoreParts[]): number[] {
  const top = (k: keyof ScoreParts) => Math.max(...parts.map((p) => p[k]))
  const tops = { activeDays: top('activeDays'), streak: top('streak'), tokens: top('tokens'), features: top('features') }
  return parts.map((p) =>
    Math.round(
      SCORE_WEIGHTS.activeDays * share(p.activeDays, tops.activeDays) +
        SCORE_WEIGHTS.streak * share(p.streak, tops.streak) +
        SCORE_WEIGHTS.tokens * share(p.tokens, tops.tokens) +
        SCORE_WEIGHTS.features * share(p.features, tops.features),
    ),
  )
}

export async function leaderboardRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/leaderboard',
    async (request, reply) => {
      const viewer = request.user
      const orgId = viewer.orgId as OrgId
      const parsed = QuerySchema.safeParse(request.query)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
      }
      const { limit, offset, teamId } = parsed.data
      const fromDate = (parsed.data.date ?? parsed.data.from!) as IsoDate
      const toDate = (parsed.data.date ?? parsed.data.to!) as IsoDate

      const settings = await leaderboardSettings(orgId)
      const isDeveloper = viewer.role !== 'admin' && viewer.role !== 'manager'
      // A developer in rank or full mode is ranked against the whole org. A
      // team filter still goes through readScope, which keeps them to themselves.
      const widened = isDeveloper && settings.developerView !== 'own' && !teamId
      const scope = widened ? undefined : await readScope(viewer, teamId)
      if (scope === 403 || scope === 404) return reply.status(scope).send(scopeError(scope))
      // A widened developer has scope undefined, so the whole-org rule covers them.
      await auditView(request, 'leaderboard', scope, teamId)
      // Server side, so a developer cannot read anyone's spend by sorting on it.
      const othersCost = !isDeveloper || settings.showOthersCost
      const sort = parsed.data.sort === 'cost' && !othersCost ? 'activeDays' : parsed.data.sort

      const store = getStore()
      const [facet] = await store.dailySnapshots.aggregate<LeaderboardFacet>(
        leaderboardPipeline(orgId, fromDate, toDate, scope),
      )
      const ranked = facet?.users ?? []
      if (ranked.length === 0) return []

      // The `inner join users` the Postgres query opened with, as one lookup
      // covering everyone in range rather than only the page. Scoped to the
      // caller's org as well as the id: the ids come from snapshots already
      // matched on `orgId`, so a snapshot whose user sits in another org is
      // corrupt rather than merely unusual, and resolving that person's name
      // into this response would be a cross-org leak.
      // The union, though `everyone` is an `$addToSet` over the same `$match`
      // the ranking came from and is therefore always a superset. Spelling it
      // out costs one line and means the ranking is covered by its own
      // integrity check rather than by that reasoning staying true: a broken
      // `everyone` branch now reaches the named throw below instead of a
      // TypeError on the first row it cannot resolve.
      const ids = [...new Set([...ranked.map((row) => row._id), ...(facet?.everyone[0]?.ids ?? [])])]
      const people = await store.users.find(
        { _id: { $in: ids }, orgId },
        { projection: { name: 1, email: 1, hideOnLeaderboard: 1 } },
      )
      const byId = new Map(people.map((user) => [user._id as string, user]))

      // Loud, not short. Postgres declared `daily_snapshots.user_id` NOT NULL
      // with a cascading foreign key, so a snapshot whose user was gone could
      // not exist and the inner join never dropped a row. MongoDB enforces no
      // such thing, so the same join silently drops the row instead — and a
      // leaderboard missing people is indistinguishable from an org where
      // nobody spent anything.
      //
      // This is narrower than "the users collection is empty". Both writers of
      // dailySnapshots go through rebuildDailySnapshot, which throws on a
      // missing user inside the transaction, so the application cannot commit
      // an orphan: with no users there are no snapshots either, and the empty
      // range returns above without reading this collection at all. What
      // reaches here is a half-finished Phase 7 backfill, or a user deleted
      // without their snapshots — and in both the honest answer is that this
      // page cannot be drawn, not a shorter version of it.
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

      // Streaks are all time, not range-bound, and cover every ranked person
      // because the streak and score sorts need them. At most one row per user-day.
      const now = today()
      const [activeRows, mcpRows] = await Promise.all([
        store.dailySnapshots.find(
          { orgId, userId: { $in: ranked.map((row) => row._id) }, totalTokens: { $gt: 0 } },
          { projection: { userId: 1, date: 1 } },
        ),
        store.claudeEnrichment.aggregate<{ _id: UserId; servers: string[] }>(
          mcpServersPipeline({ orgId, userIds: scope, from: fromDate, to: toDate }),
        ),
      ])
      const datesByUser = new Map<string, string[]>()
      for (const row of activeRows) {
        const list = datesByUser.get(row.userId) ?? []
        list.push(row.date)
        datesByUser.set(row.userId, list)
      }
      const mcpByUser = new Map(mcpRows.map((row) => [row._id as string, [...row.servers].sort()]))
      // "12 of 30": start the count at the first usage day among the ranked
      // people, so "All time" does not read "of ~2,500" (as A3's funnel clamp).
      const first = activeRows.reduce<string>((min, row) => (row.date < min ? row.date : min), toDate)
      const start = first > fromDate ? first : fromDate
      const rangeDays = (Date.parse(toDate) - Date.parse(start)) / 86_400_000 + 1

      const rows = ranked.map((row) => {
        const agents = [...(spendByUser.get(row._id) ?? new Map<string, AgentTotals>()).values()]
          .filter((a) => a.tokens > 0)
          .map((a) => a._id.agent as AgentName)
          .sort()
        const features = { agents, mcpServers: mcpByUser.get(row._id) ?? [] }
        const streak: Streak = streaks(datesByUser.get(row._id) ?? [], now)
        return { row, streak, features, featureCount: agents.length + features.mcpServers.length, score: 0 }
      })

      const scores = scoreAll(
        rows.map((r) => ({ activeDays: r.row.activeDays, streak: r.streak.current, tokens: r.row.totalTokens, features: r.featureCount })),
      )
      rows.forEach((r, i) => (r.score = scores[i]))

      const key: Record<LeaderboardSort, (r: (typeof rows)[number]) => number> = {
        activeDays: (r) => r.row.activeDays,
        score: (r) => r.score,
        streak: (r) => r.streak.current,
        tokens: (r) => r.row.totalTokens,
        cost: (r) => r.row.totalCostMicros,
      }
      const by = key[sort]
      // Ties fall back to tokens then `_id`, so a page boundary is stable.
      rows.sort((a, b) =>
        by(b) - by(a) || b.row.totalTokens - a.row.totalTokens || (a.row._id < b.row._id ? -1 : a.row._id > b.row._id ? 1 : 0),
      )
      const ranks: number[] = []
      rows.forEach((r, i) => ranks.push(i > 0 && by(r) === by(rows[i - 1]) ? ranks[i - 1] : i + 1))

      // Rank mode: the developer's own row and where it sits, no other people.
      const positions = rows.map((_, i) => i)
      const page = isDeveloper && settings.developerView === 'rank'
        ? positions.filter((i) => rows[i].row._id === viewer.userId)
        : positions.slice(offset, offset + limit)

      // Seats of the page only: actual cost is per person.
      const pageIds = page.map((i) => rows[i].row._id)
      const seats = pageIds.length ? await store.seats.find({ orgId, userId: { $in: pageIds } }) : []
      const seated = new Set(seats.map((seat) => seat._id))
      const seatMicrosByUser = new Map<string, number>()
      for (const seat of seats) {
        const cost = seatCost(seat, fromDate, toDate, now)
        seatMicrosByUser.set(seat.userId, (seatMicrosByUser.get(seat.userId) ?? 0) + cost)
      }

      const result: LeaderboardEntry[] = page.map((i) => {
        const { row, streak, features, score } = rows[i]
        const self = row._id === viewer.userId
        const user = byId.get(row._id)!
        // The security boundary for names and cost: masked values never leave the API.
        const hidden = viewer.role !== 'admin' && !self && (user.hideOnLeaderboard || !settings.showNames)
        const showCost = othersCost || self
        const usd = (micros: number) => (showCost ? usdFromMicros(micros as Micros) : null)
        const perAgent = spendByUser.get(row._id)
        const agent = (name: AgentName) => {
          const totals = perAgent?.get(name)
          if (!totals) return showCost ? noSpend() : { tokens: 0, costUsd: null }
          return { tokens: totals.tokens, costUsd: usd(totals.costMicros) }
        }
        let apiMicros = 0
        for (const [name, totals] of perAgent ?? []) {
          if (!seated.has(seatKey(row._id, name))) apiMicros += totals.costMicros
        }
        const actualMicros = (seatMicrosByUser.get(row._id) ?? 0) + apiMicros
        return {
          // "Person N" is stable by rank; a masked row gets no real id either.
          userId: hidden ? `person-${i + 1}` : row._id,
          name: hidden ? (user.hideOnLeaderboard ? 'Anonymous' : `Person ${i + 1}`) : user.name,
          email: hidden ? '' : user.email,
          claude: agent('claude'),
          qwen: agent('qwen'),
          gemini: agent('gemini'),
          codex: agent('codex'),
          copilot: agent('copilot'),
          totalCostUsd: usd(row.totalCostMicros),
          totalTokens: row.totalTokens,
          sessions: row.sessions,
          // Carried over unchanged: the Postgres query selected a literal null
          // here. The per-day figure now lives on `DailySnapshotDoc.cacheHitRate`
          // and could be surfaced, but a mean of daily rates is not the rate
          // over the range, so turning it on is its own change with its own
          // decision about weighting.
          cacheHitRate: null,
          actualCostUsd: usd(actualMicros),
          apiSpendUsd: usd(apiMicros),
          valueMultiple: showCost && actualMicros > 0 ? row.totalCostMicros / actualMicros : null,
          rank: ranks[i],
          outOf: rows.length,
          rangeDays,
          score,
          activeDays: row.activeDays,
          streak,
          features,
        }
      })

      return result
    },
  )

  // GET /leaderboard/settings — org settings plus the caller's own hide flag. Any dashboard role.
  fastify.get('/leaderboard/settings', async (request) => {
    const orgId = request.user.orgId as OrgId
    const [settings, me] = await Promise.all([
      leaderboardSettings(orgId),
      getStore().users.findOne(
        { _id: request.user.userId as UserId, orgId },
        { projection: { hideOnLeaderboard: 1 } },
      ),
    ])
    return { ...settings, hideOnLeaderboard: me?.hideOnLeaderboard ?? false } satisfies LeaderboardSettingsResponse
  })

  // PUT /leaderboard/settings — admin only, all three at once.
  fastify.put('/leaderboard/settings', { preHandler: requireAdmin(fastify) }, async (request) => {
    const body = LeaderboardSettingsSchema.parse(request.body)
    await getStore().organizations.updateOne({ _id: request.user.orgId as OrgId }, { $set: { leaderboard: body } })
    await audit(request, {
      action: 'org.leaderboard_settings',
      target: { type: 'org', id: request.user.orgId, label: null },
      detail: body,
    })
    return body
  })

  // PUT /leaderboard/me — the caller's own "Hide my name on the leaderboard".
  // Never audited: a person's own privacy choice, and a log of it would hand
  // admins a list of who hid themselves.
  fastify.put('/leaderboard/me', async (request) => {
    const { hideOnLeaderboard } = HideOnLeaderboardSchema.parse(request.body)
    await getStore().users.updateOne(
      { _id: request.user.userId as UserId, orgId: request.user.orgId as OrgId },
      { $set: { hideOnLeaderboard } },
    )
    return { hideOnLeaderboard }
  })
}
