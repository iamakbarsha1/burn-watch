import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { z } from 'zod'
import { getStore, type IsoDate, type OrgId, type TeamId, type UserId } from '@burn-watch/db'
import {
  FREE_TIER_AGENTS,
  type AgentName,
  type FreeTierResponse,
  type FreeTierRow,
  type FreeTierTeamTotal,
} from '@burn-watch/shared'
import { comparableTeams, readScope } from '../../plugins/jwt.js'
import { dateRangeFields, scopeError, teamIdField } from './query-schema.js'

const QuerySchema = z
  .object({ ...dateRangeFields, ...teamIdField })
  .refine((d) => d.from && d.to, { message: 'Provide from+to' })

/** One (user, agent, model) group of free-tier rows over the range. */
interface FreeTierGroup {
  _id: { userId: UserId; agent: AgentName; modelName: string }
  days: number
  tokens: number
  firstDate: IsoDate
  lastDate: IsoDate
}

/**
 * B1: every free-tier usage row in range, grouped per user, agent and model.
 * `userIds` undefined means the whole org (admin with no team filter).
 */
export function freeTierPipeline(orgId: OrgId, from: IsoDate, to: IsoDate, userIds?: UserId[]): Document[] {
  return [
    {
      $match: {
        orgId,
        isFreeTier: true,
        date: { $gte: from, $lte: to },
        ...(userIds && { userId: { $in: userIds } }),
      },
    },
    {
      $group: {
        _id: { userId: '$userId', agent: '$agent', modelName: '$modelName' },
        dates: { $addToSet: '$date' },
        tokens: { $sum: '$totalTokens' },
        firstDate: { $min: '$date' },
        lastDate: { $max: '$date' },
      },
    },
    { $project: { days: { $size: '$dates' }, tokens: 1, firstDate: 1, lastDate: 1 } },
    { $sort: { tokens: -1 } },
  ]
}

export async function governanceRoutes(fastify: FastifyInstance) {
  // GET /governance/free-tier — admins see the org, managers their own teams.
  fastify.get('/governance/free-tier', async (request, reply) => {
    if (request.user.role !== 'admin' && request.user.role !== 'manager') {
      return reply.status(403).send({ error: 'Governance requires admin or manager role' })
    }
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const from = parsed.data.from as IsoDate
    const to = parsed.data.to as IsoDate

    const scope = await readScope(request.user, parsed.data.teamId)
    if (scope === 403 || scope === 404) return reply.status(scope).send(scopeError(scope))

    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const groups = await store.usageEvents.aggregate<FreeTierGroup>(freeTierPipeline(orgId, from, to, scope))
    if (groups.length === 0) return { rows: [], byTeam: [] } satisfies FreeTierResponse

    const ids = [...new Set(groups.map((g) => g._id.userId))]
    // Team names only from teams the viewer may see, so a manager never learns
    // the name of a team they do not manage.
    const [users, teams] = await Promise.all([
      store.users.find({ _id: { $in: ids }, orgId }, { projection: { name: 1, email: 1 } }),
      comparableTeams(request.user),
    ])
    const members = teams.length
      ? await store.teamMembers.find({ orgId, teamId: { $in: teams.map((t) => t._id) }, userId: { $in: ids } })
      : []

    const userById = new Map(users.map((u) => [u._id, u]))
    const teamName = new Map(teams.map((t) => [t._id, t.name]))
    const teamsOf = new Map<UserId, TeamId[]>()
    for (const m of members) {
      if (!ids.includes(m.userId) || !teamName.has(m.teamId)) continue
      teamsOf.set(m.userId, [...(teamsOf.get(m.userId) ?? []), m.teamId])
    }

    const rows = groups.map<FreeTierRow>((g) => ({
      userId: g._id.userId,
      userName: userById.get(g._id.userId)?.name ?? null,
      userEmail: userById.get(g._id.userId)?.email ?? null,
      teams: (teamsOf.get(g._id.userId) ?? []).map((id) => teamName.get(id)!).sort(),
      agent: g._id.agent,
      modelName: g._id.modelName,
      reason: FREE_TIER_AGENTS.has(g._id.agent) ? 'free-tier-agent' : 'unpriced-model',
      days: g.days,
      tokens: g.tokens,
      firstDate: g.firstDate,
      lastDate: g.lastDate,
    }))

    // A user in two teams counts in both, as on /teams/compare.
    const totals = new Map<TeamId | null, { users: Set<UserId>; tokens: number }>()
    for (const g of groups) {
      const userTeams = teamsOf.get(g._id.userId) ?? []
      for (const key of userTeams.length ? userTeams : [null]) {
        const t = totals.get(key) ?? { users: new Set(), tokens: 0 }
        t.users.add(g._id.userId)
        t.tokens += g.tokens
        totals.set(key, t)
      }
    }
    const byTeam = [...totals]
      .map<FreeTierTeamTotal>(([teamId, t]) => ({
        teamId,
        teamName: teamId ? teamName.get(teamId)! : null,
        users: t.users.size,
        tokens: t.tokens,
      }))
      .sort((a, b) => b.tokens - a.tokens)

    return { rows, byTeam } satisfies FreeTierResponse
  })
}
