import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { z } from 'zod'
import { getStore, mcpApprovalKey, type IsoDate, type OrgId, type TeamId, type UserId } from '@burn-watch/db'
import {
  FREE_TIER_AGENTS,
  McpApprovalInputSchema,
  McpServerKeySchema,
  type AgentName,
  type FreeTierResponse,
  type FreeTierRow,
  type FreeTierTeamTotal,
  type McpInventoryResponse,
  type McpServerRow,
  type McpServerSource,
} from '@burn-watch/shared'
import { comparableTeams, readScope, requireAdmin } from '../../plugins/jwt.js'
import { enrichmentMatch, type EnrichmentRange } from './enrichment.js'
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

/** One MCP server key over the range, summed across every user in scope. */
interface McpGroup {
  _id: string
  calls: number
  users: UserId[]
  days: number
  lastDate: IsoDate
}

/**
 * B3: per MCP server key, calls, distinct users, distinct days and last date.
 * Same unwind shape as `toolUsageTotals`; the key stays a value throughout.
 */
export function mcpInventoryPipeline(range: EnrichmentRange): Document[] {
  return [
    enrichmentMatch(range),
    { $project: { userId: 1, date: 1, entries: { $objectToArray: { $ifNull: ['$mcpUsage', {}] } } } },
    { $unwind: '$entries' },
    {
      $group: {
        _id: '$entries.k',
        calls: { $sum: '$entries.v' },
        users: { $addToSet: '$userId' },
        dates: { $addToSet: '$date' },
        lastDate: { $max: '$date' },
      },
    },
    { $project: { calls: 1, users: 1, days: { $size: '$dates' }, lastDate: 1 } },
    { $sort: { calls: -1, _id: 1 } },
  ]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The prefix is the only hint: the agent sends the name, never a URL or command. */
export function mcpSource(server: string): McpServerSource {
  if (server.startsWith('plugin_')) return 'plugin'
  if (server.startsWith('claude_ai_')) return 'claude.ai'
  if (UUID.test(server)) return 'unnamed'
  return 'local'
}

// The key travels in the body or query, not the path: Fastify caps path params
// at 100 characters, and a key may hold a `/`.
const ServerQuery = z.object({ server: McpServerKeySchema })

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

  // GET /governance/mcp — B3 inventory. Same role rules as free-tier; managers read approvals too.
  fastify.get('/governance/mcp', async (request, reply) => {
    if (request.user.role !== 'admin' && request.user.role !== 'manager') {
      return reply.status(403).send({ error: 'Governance requires admin or manager role' })
    }
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const scope = await readScope(request.user, parsed.data.teamId)
    if (scope === 403 || scope === 404) return reply.status(scope).send(scopeError(scope))

    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const [groups, approvals] = await Promise.all([
      store.claudeEnrichment.aggregate<McpGroup>(
        mcpInventoryPipeline({ orgId, userIds: scope, from: parsed.data.from as IsoDate, to: parsed.data.to as IsoDate }),
      ),
      store.mcpApprovals.find({ orgId }),
    ])

    const ids = [...new Set(groups.flatMap((g) => g.users))]
    const users = ids.length
      ? await store.users.find({ _id: { $in: ids }, orgId }, { projection: { name: 1 } })
      : []
    const nameOf = new Map(users.map((u) => [u._id, u.name]))
    const approvalOf = new Map(approvals.map((a) => [a.server, a]))

    const servers = groups.map<McpServerRow>((g) => ({
      server: g._id,
      source: mcpSource(g._id),
      approved: approvalOf.has(g._id),
      note: approvalOf.get(g._id)?.note ?? null,
      users: g.users
        .map((userId) => ({ userId, name: nameOf.get(userId) ?? null }))
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
      calls: g.calls,
      days: g.days,
      lastDate: g.lastDate,
    }))
    const used = new Set(groups.map((g) => g._id))
    const unusedApprovals = approvals
      .filter((a) => !used.has(a.server))
      .map((a) => ({ server: a.server, note: a.note }))
      .sort((a, b) => a.server.localeCompare(b.server))

    return { servers, unusedApprovals } satisfies McpInventoryResponse
  })

  const admin = { preHandler: requireAdmin(fastify) }

  // PUT /governance/mcp-approvals { server, note? } — approve one exact key, or change its note.
  fastify.put('/governance/mcp-approvals', admin, async (request) => {
    const { server, note } = McpApprovalInputSchema.parse(request.body)
    const orgId = request.user.orgId as OrgId
    await getStore().mcpApprovals.updateOne(
      { _id: mcpApprovalKey(orgId, server) },
      {
        $set: { note: note || null, approvedBy: request.user.userId as UserId, approvedAt: new Date() },
        $setOnInsert: { orgId, server },
      },
      { upsert: true },
    )
    return { server, approved: true }
  })

  // DELETE /governance/mcp-approvals?server= — another org's approval deletes nothing and answers 404.
  fastify.delete('/governance/mcp-approvals', admin, async (request, reply) => {
    const { server } = ServerQuery.parse(request.query)
    const orgId = request.user.orgId as OrgId
    const deleted = await getStore().mcpApprovals.deleteOne({ _id: mcpApprovalKey(orgId, server), orgId })
    if (deleted === 0) return reply.status(404).send({ error: 'Approval not found' })
    return { server, approved: false }
  })
}
