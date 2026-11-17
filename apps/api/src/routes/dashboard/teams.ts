import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Document } from 'mongodb'
import { z } from 'zod'
import type { AgentSummary, Team, TeamComparison } from '@burn-watch/shared'
import {
  getStore,
  newId,
  teamMemberKey,
  usdFromMicros,
  type IsoDate,
  type Micros,
  type OrgId,
  type TeamId,
  type UserId,
} from '@burn-watch/db'
import { comparableTeams, requireAdmin } from '../../plugins/jwt.js'
import { dateQuerySchema } from './query-schema.js'
import { AGENTS } from './overview.js'

const TeamParams = z.object({ id: z.string().uuid() })
const MemberParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() })
const NameBody = z.object({ name: z.string().trim().min(1).max(100) })
const RoleBody = z.object({ role: z.enum(['manager', 'member']) })

const isDuplicateKey = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000

const duplicateName = (reply: FastifyReply) =>
  reply.status(409).send({ error: 'A team with this name already exists' })

interface UserRow {
  _id: UserId
  costMicros: Micros
  tokens: number
}

interface UserAgentRow {
  _id: { userId: UserId; agent: string }
  tokens: number
  costMicros: Micros
}

interface UserDayRow {
  userId: UserId
  date: IsoDate
  totalCostMicros: Micros
}

interface CompareFacet {
  users: UserRow[]
  agents: UserAgentRow[]
  daily: UserDayRow[]
}

/**
 * Per-user totals, per-user agent split and per-user days for a set of users.
 * Grouped per user, not per team: a user can sit in several teams, and the
 * team sums are done in the route from the member map, which is small.
 */
export function teamComparePipeline(orgId: OrgId, from: IsoDate, to: IsoDate, userIds: UserId[]): Document[] {
  return [
    { $match: { orgId, userId: { $in: userIds }, date: { $gte: from, $lte: to } } },
    {
      $facet: {
        users: [
          {
            $group: {
              _id: '$userId',
              costMicros: { $sum: '$totalCostMicros' },
              tokens: { $sum: '$totalTokens' },
            },
          },
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
        // dailySnapshots is one document per user-day already.
        daily: [{ $project: { _id: 0, userId: 1, date: 1, totalCostMicros: 1 } }],
      },
    },
  ]
}

export async function teamsRoutes(fastify: FastifyInstance) {
  // GET /teams — teams the viewer can filter by, with member names.
  fastify.get('/teams', async (request) => {
    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const teams = await comparableTeams(request.user)
    if (teams.length === 0) return [] as Team[]

    const members = await store.teamMembers.find({ orgId, teamId: { $in: teams.map((t) => t._id) } })
    const ids = [...new Set(members.map((m) => m.userId))]
    const users = ids.length ? await store.users.find({ _id: { $in: ids }, orgId }, { projection: { name: 1 } }) : []
    const names = new Map(users.map((u) => [u._id, u.name]))

    return teams.map<Team>((t) => ({
      id: t._id,
      name: t.name,
      members: members
        .filter((m) => m.teamId === t._id)
        .map((m) => ({ userId: m.userId, name: names.get(m.userId) ?? null, role: m.role })),
    }))
  })

  // GET /teams/compare — C5. Admins compare every team, managers the teams they manage.
  fastify.get('/teams/compare', async (request, reply) => {
    if (request.user.role !== 'admin' && request.user.role !== 'manager') {
      return reply.status(403).send({ error: 'Team comparison requires admin or manager role' })
    }
    const parsed = dateQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const from = (parsed.data.date ?? parsed.data.from!) as IsoDate
    const to = (parsed.data.date ?? parsed.data.to!) as IsoDate
    const store = getStore()
    const orgId = request.user.orgId as OrgId

    const teams = await comparableTeams(request.user)
    if (teams.length === 0) return [] as TeamComparison[]
    const members = await store.teamMembers.find({ orgId, teamId: { $in: teams.map((t) => t._id) } })
    const ids = [...new Set(members.map((m) => m.userId))]

    const [facet] = ids.length
      ? await store.dailySnapshots.aggregate<CompareFacet>(teamComparePipeline(orgId, from, to, ids))
      : []

    const byUser = new Map((facet?.users ?? []).map((u) => [u._id, u]))

    return teams.map<TeamComparison>((t) => {
      const team = new Set(members.filter((m) => m.teamId === t._id).map((m) => m.userId))
      let cost = 0
      let tokens = 0
      let active = 0
      for (const id of team) {
        const u = byUser.get(id)
        if (!u) continue
        active++
        cost += u.costMicros
        tokens += u.tokens
      }

      const agentTotals = new Map<string, { tokens: number; costMicros: number }>()
      for (const row of facet?.agents ?? []) {
        if (!team.has(row._id.userId)) continue
        const a = agentTotals.get(row._id.agent) ?? { tokens: 0, costMicros: 0 }
        a.tokens += row.tokens
        a.costMicros += row.costMicros
        agentTotals.set(row._id.agent, a)
      }
      const byAgent = AGENTS.map<AgentSummary>((agent) => {
        const a = agentTotals.get(agent)
        const costUsd = usdFromMicros((a?.costMicros ?? 0) as Micros)
        return { agent, tokens: a?.tokens ?? 0, costUsd, isFreeTier: costUsd === 0 }
      })

      const days = new Map<string, number>()
      for (const row of facet?.daily ?? []) {
        if (team.has(row.userId)) days.set(row.date, (days.get(row.date) ?? 0) + row.totalCostMicros)
      }
      const daily = [...days]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, micros]) => ({ date, totalCost: usdFromMicros(micros as Micros) }))

      return {
        teamId: t._id,
        name: t.name,
        memberCount: team.size,
        activeUsers: active,
        // Summed in micros, converted once, for the reason overview.ts gives.
        totalCostUsd: usdFromMicros(cost as Micros),
        totalTokens: tokens,
        byAgent,
        daily,
      }
    })
  })

  // POST /teams — admin only.
  fastify.post('/teams', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    const { name } = NameBody.parse(request.body)
    const id = newId<TeamId>()
    try {
      await getStore().teams.insertOne({ _id: id, orgId: request.user.orgId as OrgId, name, createdAt: new Date() })
    } catch (err) {
      if (isDuplicateKey(err)) return duplicateName(reply)
      throw err
    }
    return reply.status(201).send({ id })
  })

  // PATCH /teams/:id — admin only, rename. Another org's team answers 404.
  fastify.patch('/teams/:id', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    const { id } = TeamParams.parse(request.params)
    const { name } = NameBody.parse(request.body)
    const orgId = request.user.orgId as OrgId
    try {
      const updated = await getStore().teams.findOneAndUpdate({ _id: id as TeamId, orgId }, { $set: { name } })
      if (!updated) return reply.status(404).send({ error: 'Team not found' })
    } catch (err) {
      if (isDuplicateKey(err)) return duplicateName(reply)
      throw err
    }
    return { id }
  })

  // DELETE /teams/:id — admin only. Members go first: an orphaned manager row
  // would keep widening that manager's scope after the team is gone. Both
  // deletes filter on orgId, so another org's id deletes nothing.
  fastify.delete('/teams/:id', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    const { id } = TeamParams.parse(request.params)
    const orgId = request.user.orgId as OrgId
    const store = getStore()
    await store.teamMembers.deleteMany({ teamId: id as TeamId, orgId })
    const deleted = await store.teams.deleteOne({ _id: id as TeamId, orgId })
    if (deleted === 0) return reply.status(404).send({ error: 'Team not found' })
    return { id }
  })

  // PUT /teams/:id/members/:userId — admin only. Adds the user or changes their role.
  fastify.put('/teams/:id/members/:userId', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    const { id, userId } = MemberParams.parse(request.params)
    const { role } = RoleBody.parse(request.body)
    const orgId = request.user.orgId as OrgId
    const store = getStore()
    const teamId = id as TeamId

    if (!(await store.teams.findOne({ _id: teamId, orgId }))) {
      return reply.status(404).send({ error: 'Team not found' })
    }
    // Same check budget-alerts POST does: never attach another org's user.
    if (!(await store.users.findOne({ _id: userId as UserId, orgId }))) {
      return reply.status(400).send({ error: 'User not found in this organization' })
    }

    await store.teamMembers.updateOne(
      { _id: teamMemberKey(teamId, userId as UserId) },
      {
        $set: { role },
        $setOnInsert: { teamId, orgId, userId: userId as UserId, createdAt: new Date() },
      },
      { upsert: true },
    )
    return { teamId, userId, role }
  })

  // DELETE /teams/:id/members/:userId — admin only.
  fastify.delete('/teams/:id/members/:userId', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    const { id, userId } = MemberParams.parse(request.params)
    const orgId = request.user.orgId as OrgId
    const deleted = await getStore().teamMembers.deleteOne({
      _id: teamMemberKey(id as TeamId, userId as UserId),
      orgId,
    })
    if (deleted === 0) return reply.status(404).send({ error: 'Member not found' })
    return { teamId: id, userId }
  })
}
