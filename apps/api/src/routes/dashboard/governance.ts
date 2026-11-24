import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { z } from 'zod'
import {
  agentPolicyKey,
  getStore,
  mcpApprovalKey,
  type AgentPolicyDoc,
  type IsoDate,
  type OrgId,
  type TeamId,
  type UserId,
} from '@burn-watch/db'
import {
  AgentNameSchema,
  AgentPolicyInputSchema,
  ClaudeOrgsInputSchema,
  FREE_TIER_AGENTS,
  McpApprovalInputSchema,
  McpServerKeySchema,
  type AgentName,
  type AgentPolicy,
  type ClaudeAccountsResponse,
  type FreeTierResponse,
  type FreeTierRow,
  type FreeTierTeamTotal,
  type McpInventoryResponse,
  type McpServerRow,
  type McpServerSource,
  type ViolationReason,
  type ViolationRow,
  type ViolationsResponse,
} from '@burn-watch/shared'
import { comparableTeams, readScope, requireAdmin, type JwtPayload } from '../../plugins/jwt.js'
import { enrichmentMatch, type EnrichmentRange } from './enrichment.js'
import { groupAccounts } from './accounts.js'
import { audit, auditView } from '../../audit.js'
import { dateRangeFields, isRefusal, refuse, teamIdField } from './query-schema.js'
import { daysBefore, today } from './dates.js'

const QuerySchema = z
  .object({ ...dateRangeFields, ...teamIdField })
  .refine((d) => d.from && d.to, { message: 'Provide from+to' })

/** One (user, agent, model) group of usage rows over the range. */
interface UsageGroup {
  _id: { userId: UserId; agent: AgentName; modelName: string }
  days: number
  tokens: number
  firstDate: IsoDate
  lastDate: IsoDate
}

/** Usage rows matching `match`, grouped per user, agent and model. Shared by B1 and B2. */
function usageGroupPipeline(match: Document): Document[] {
  return [
    { $match: match },
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

/**
 * B1: every free-tier usage row in range, grouped per user, agent and model.
 * `userIds` undefined means the whole org (admin with no team filter).
 */
export function freeTierPipeline(orgId: OrgId, from: IsoDate, to: IsoDate, userIds?: UserId[]): Document[] {
  return usageGroupPipeline({
    orgId,
    isFreeTier: true,
    date: { $gte: from, $lte: to },
    ...(userIds && { userId: { $in: userIds } }),
  })
}

const AGENT_NAMES = AgentNameSchema.options

/**
 * B2: the `$or` branches that select usage outside the policy. An agent with
 * no rule or a blocked rule matches whole; a models-only agent matches every
 * model not listed, by exact name. Empty means nothing can violate.
 */
export function violationBranches(policies: Pick<AgentPolicyDoc, 'agent' | 'rule' | 'models'>[]): Document[] {
  const byAgent = new Map(policies.map((p) => [p.agent, p]))
  const whole = AGENT_NAMES.filter((a) => !byAgent.has(a) || byAgent.get(a)!.rule === 'blocked')
  const models = AGENT_NAMES.flatMap((a) => {
    const p = byAgent.get(a)
    return p?.rule === 'models' ? [{ agent: a, modelName: { $nin: p.models } }] : []
  })
  return [...(whole.length ? [{ agent: { $in: whole } }] : []), ...models]
}

export function violationReason(policies: Map<AgentName, AgentPolicyDoc>, agent: AgentName): ViolationReason {
  const rule = policies.get(agent)?.rule
  return rule === 'blocked' ? 'agent-blocked' : rule === 'models' ? 'model-not-listed' : 'agent-not-set'
}

/**
 * Names, emails and team names for usage groups, plus per-team totals. Team
 * names only come from teams the viewer may see, so a manager never learns the
 * name of a team they do not manage.
 */
async function nameGroups<R>(
  viewer: JwtPayload,
  groups: UsageGroup[],
  reasonOf: (g: UsageGroup) => R,
) {
  if (groups.length === 0) return { rows: [], byTeam: [] }
  const store = getStore()
  const orgId = viewer.orgId as OrgId
  const ids = [...new Set(groups.map((g) => g._id.userId))]
  const [users, teams] = await Promise.all([
    store.users.find({ _id: { $in: ids }, orgId }, { projection: { name: 1, email: 1 } }),
    comparableTeams(viewer),
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

  const rows = groups.map((g) => ({
    userId: g._id.userId,
    userName: userById.get(g._id.userId)?.name ?? null,
    userEmail: userById.get(g._id.userId)?.email ?? null,
    teams: (teamsOf.get(g._id.userId) ?? []).map((id) => teamName.get(id)!).sort(),
    agent: g._id.agent,
    modelName: g._id.modelName,
    reason: reasonOf(g),
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

  return { rows, byTeam }
}

/** Number of violation groups in the org over the last 30 days: the admin alert. */
export async function violationCount(orgId: OrgId): Promise<number> {
  const store = getStore()
  const branches = violationBranches(await store.agentPolicies.find({ orgId }))
  if (branches.length === 0) return 0
  const to = today()
  const [r] = await store.usageEvents.aggregate<{ n: number }>([
    ...usageGroupPipeline({ orgId, date: { $gte: daysBefore(to, 29), $lte: to }, $or: branches }).slice(0, 2),
    { $count: 'n' },
  ])
  return r?.n ?? 0
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
    if (isRefusal(scope)) return refuse(reply, scope)
    await auditView(request, 'governance', scope, parsed.data.teamId)

    const orgId = request.user.orgId as OrgId
    const groups = await getStore().usageEvents.aggregate<UsageGroup>(freeTierPipeline(orgId, from, to, scope))
    const named = await nameGroups(request.user, groups, (g) =>
      FREE_TIER_AGENTS.has(g._id.agent) ? ('free-tier-agent' as const) : ('unpriced-model' as const),
    )
    return named satisfies FreeTierResponse
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
    if (isRefusal(scope)) return refuse(reply, scope)
    await auditView(request, 'governance', scope, parsed.data.teamId)

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

  // GET /governance/violations — B2. The policy for all five agents, usage
  // outside it, and (admins) the models seen per agent for the edit form.
  fastify.get('/governance/violations', async (request, reply) => {
    const { role } = request.user
    if (role !== 'admin' && role !== 'manager') {
      return reply.status(403).send({ error: 'Governance requires admin or manager role' })
    }
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const scope = await readScope(request.user, parsed.data.teamId)
    if (isRefusal(scope)) return refuse(reply, scope)
    await auditView(request, 'governance', scope, parsed.data.teamId)

    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const base = {
      orgId,
      date: { $gte: parsed.data.from as IsoDate, $lte: parsed.data.to as IsoDate },
      ...(scope && { userId: { $in: scope } }),
    }
    const docs = await store.agentPolicies.find({ orgId })
    const byAgent = new Map(docs.map((d) => [d.agent, d]))
    const branches = violationBranches(docs)

    const [groups, seen] = await Promise.all([
      branches.length ? store.usageEvents.aggregate<UsageGroup>(usageGroupPipeline({ ...base, $or: branches })) : [],
      role === 'admin'
        ? store.usageEvents.aggregate<{ _id: AgentName; models: string[] }>([
            { $match: base },
            { $group: { _id: '$agent', models: { $addToSet: '$modelName' } } },
          ])
        : [],
    ])
    const named = await nameGroups(request.user, groups, (g) => violationReason(byAgent, g._id.agent))

    return {
      policies: AGENT_NAMES.map<AgentPolicy>((agent) => {
        const d = byAgent.get(agent)
        return { agent, rule: d?.rule ?? 'unset', models: d?.models ?? [], note: d?.note ?? null }
      }),
      rows: named.rows as ViolationRow[],
      byTeam: named.byTeam,
      seenModels: Object.fromEntries(seen.map((s) => [s._id, [...s.models].sort()])),
    } satisfies ViolationsResponse
  })

  // GET /governance/accounts — R2 B6. Admins only (Decision 2): Claude orgs and
  // accounts seen, as labels, and per-person flags. Hashes are never rendered.
  fastify.get('/governance/accounts', admin, async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const from = parsed.data.from as IsoDate
    const to = parsed.data.to as IsoDate
    const { teamId } = parsed.data
    const scope = await readScope(request.user, teamId)
    if (isRefusal(scope)) return refuse(reply, scope)
    await auditView(request, 'governance', scope, teamId)

    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const inScope = scope && { userId: { $in: scope } }
    const [docs, org, seats, teams] = await Promise.all([
      store.claudeEnrichment.find(
        { orgId, date: { $gte: from, $lte: to }, ...inScope },
        { projection: { userId: 1, date: 1, accountHashes: 1, claudeOrgHashes: 1 } },
      ),
      store.organizations.findOne({ _id: orgId }, { projection: { ownClaudeOrgHashes: 1 } }),
      store.seats.find({ orgId, agent: 'claude', ...inScope }, { projection: { userId: 1 } }),
      comparableTeams(request.user),
    ])
    const own = org?.ownClaudeOrgHashes ?? []
    const grouped = groupAccounts(docs, {
      own,
      seated: new Set(seats.map((s) => s.userId)),
      seatsEntered: seats.length,
      viewerId: request.user.userId,
    })

    const ids = grouped.people.map((p) => p.userId)
    const teamIds = teams.map((t) => t._id)
    const [users, members] = ids.length
      ? await Promise.all([
          store.users.find({ orgId, _id: { $in: ids } }, { projection: { name: 1 } }),
          teamIds.length ? store.teamMembers.find({ orgId, teamId: { $in: teamIds }, userId: { $in: ids } }) : Promise.resolve([]),
        ])
      : [[], []]
    const nameOf = new Map(users.map((u) => [u._id, u.name]))
    const teamsOf = new Map<UserId, TeamId[]>()
    for (const m of members) {
      if (!ids.includes(m.userId) || !teamIds.includes(m.teamId)) continue
      teamsOf.set(m.userId, [...(teamsOf.get(m.userId) ?? []), m.teamId])
    }
    const people = grouped.people
      .map((p) => ({ ...p, name: nameOf.get(p.userId) ?? 'Unknown', teamIds: teamsOf.get(p.userId) ?? [] }))
      .sort((a, b) => b.flags.length - a.flags.length || a.name.localeCompare(b.name))

    return {
      from,
      to,
      coverage: grouped.coverage,
      companyOrgSet: own.length > 0,
      seatsEntered: seats.length,
      companyOrgUsers: grouped.companyOrgUsers,
      orgs: grouped.orgs,
      accounts: grouped.accounts,
      people,
    } satisfies ClaudeAccountsResponse
  })

  // PUT /governance/claude-orgs { ids } — R2 B6 Decision 1. Each id must be an org
  // hash already seen in this org; [] clears. The audit row holds the count, not hashes.
  fastify.put('/governance/claude-orgs', admin, async (request, reply) => {
    const ids = [...new Set(ClaudeOrgsInputSchema.parse(request.body).ids)]
    const store = getStore()
    const orgId = request.user.orgId as OrgId
    if (ids.length) {
      const docs = await store.claudeEnrichment.find(
        { orgId, claudeOrgHashes: { $in: ids } },
        { projection: { claudeOrgHashes: 1 } },
      )
      const seen = new Set(docs.flatMap((d) => d.claudeOrgHashes ?? []))
      if (!ids.every((id) => seen.has(id))) return reply.status(400).send({ error: 'Unknown Claude org' })
    }
    await store.organizations.updateOne(
      { _id: orgId },
      ids.length ? { $set: { ownClaudeOrgHashes: ids } } : { $unset: { ownClaudeOrgHashes: '' } },
    )
    await audit(request, {
      action: 'org.claude_orgs',
      target: { type: 'org', id: orgId, label: null },
      detail: { count: ids.length },
    })
    return { count: ids.length }
  })

  // GET /governance/violations/count — the admin alert in the nav, Overview and Governance.
  fastify.get('/governance/violations/count', admin, async (request) => ({
    count: await violationCount(request.user.orgId as OrgId),
  }))

  // PUT /governance/agent-policy/:agent — set one agent's rule. The agent is a closed set, so it is safe in the path.
  fastify.put('/governance/agent-policy/:agent', admin, async (request) => {
    const agent = AgentNameSchema.parse((request.params as { agent: string }).agent)
    const body = AgentPolicyInputSchema.parse(request.body)
    const orgId = request.user.orgId as OrgId
    await getStore().agentPolicies.updateOne(
      { _id: agentPolicyKey(orgId, agent) },
      {
        $set: {
          rule: body.rule,
          models: body.rule === 'models' ? [...new Set(body.models)] : [],
          note: body.note || null,
          updatedBy: request.user.userId as UserId,
          updatedAt: new Date(),
        },
        $setOnInsert: { orgId, agent },
      },
      { upsert: true },
    )
    await audit(request, {
      action: 'policy.set',
      target: { type: 'agent', id: agent, label: agent },
      detail: { agent, rule: body.rule, models: body.rule === 'models' ? [...new Set(body.models)] : [], note: body.note || null },
    })
    return { agent, rule: body.rule }
  })

  // DELETE /governance/agent-policy/:agent — back to "not set". Another org's rule deletes nothing and answers 404.
  fastify.delete('/governance/agent-policy/:agent', admin, async (request, reply) => {
    const agent = AgentNameSchema.parse((request.params as { agent: string }).agent)
    const orgId = request.user.orgId as OrgId
    const deleted = await getStore().agentPolicies.deleteOne({ _id: agentPolicyKey(orgId, agent), orgId })
    if (deleted === 0) return reply.status(404).send({ error: 'No rule set for this agent' })
    await audit(request, { action: 'policy.unset', target: { type: 'agent', id: agent, label: agent }, detail: { agent } })
    return { agent, rule: 'unset' }
  })

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
    await audit(request, {
      action: 'mcp.approve',
      target: { type: 'mcp', id: server, label: server },
      detail: { server, note: note || null },
    })
    return { server, approved: true }
  })

  // DELETE /governance/mcp-approvals?server= — another org's approval deletes nothing and answers 404.
  fastify.delete('/governance/mcp-approvals', admin, async (request, reply) => {
    const { server } = ServerQuery.parse(request.query)
    const orgId = request.user.orgId as OrgId
    const deleted = await getStore().mcpApprovals.deleteOne({ _id: mcpApprovalKey(orgId, server), orgId })
    if (deleted === 0) return reply.status(404).send({ error: 'Approval not found' })
    await audit(request, { action: 'mcp.unapprove', target: { type: 'mcp', id: server, label: server }, detail: { server } })
    return { server, approved: false }
  })
}
