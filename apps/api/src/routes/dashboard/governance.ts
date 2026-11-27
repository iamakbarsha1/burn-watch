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
  type ClaudeAccountFlag,
  type ClaudeAccountsResponse,
  type FreeTierModelRow,
  type FreeTierResponse,
  type McpInventoryResponse,
  type McpServerRow,
  type McpServerSource,
  type SetupCheckReason,
  type SetupCheckRow,
  type SetupChecksResponse,
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

/** One (agent, model) group of usage rows over the range, with the people in it. */
export interface ModelGroup {
  _id: { agent: AgentName; modelName: string }
  users: UserId[]
  days: number
  tokens: number
}

/**
 * B1: free-tier usage in range per agent and model, with the people in each
 * group for counting. `userIds` undefined means the whole org.
 */
export function freeTierPipeline(orgId: OrgId, from: IsoDate, to: IsoDate, userIds?: UserId[]): Document[] {
  return [
    { $match: { orgId, isFreeTier: true, date: { $gte: from, $lte: to }, ...(userIds && { userId: { $in: userIds } }) } },
    {
      $group: {
        _id: { agent: '$agent', modelName: '$modelName' },
        users: { $addToSet: '$userId' },
        dates: { $addToSet: '$date' },
        tokens: { $sum: '$totalTokens' },
      },
    },
    { $project: { users: 1, days: { $size: '$dates' }, tokens: 1 } },
    { $sort: { tokens: -1, '_id.agent': 1, '_id.modelName': 1 } },
  ]
}

/** Free-tier rows and the distinct people across them. */
export function freeTierRows(groups: ModelGroup[]): FreeTierResponse {
  return {
    people: new Set(groups.flatMap((g) => g.users)).size,
    rows: groups.map<FreeTierModelRow>((g) => ({
      agent: g._id.agent,
      modelName: g._id.modelName,
      reason: FREE_TIER_AGENTS.has(g._id.agent) ? 'free-tier-agent' : 'unpriced-model',
      people: g.users.length,
      days: g.days,
      tokens: g.tokens,
    })),
  }
}

const AGENT_NAMES = AgentNameSchema.options

/**
 * B2 setup checks: the `$or` branches that select usage outside the agent rules. An agent with
 * no rule or a blocked rule matches whole; a models-only agent matches every
 * model not listed, by exact name. Empty means nothing can violate.
 */
export function setupCheckBranches(policies: Pick<AgentPolicyDoc, 'agent' | 'rule' | 'models'>[]): Document[] {
  const byAgent = new Map(policies.map((p) => [p.agent, p]))
  const whole = AGENT_NAMES.filter((a) => !byAgent.has(a) || byAgent.get(a)!.rule === 'blocked')
  const models = AGENT_NAMES.flatMap((a) => {
    const p = byAgent.get(a)
    return p?.rule === 'models' ? [{ agent: a, modelName: { $nin: p.models } }] : []
  })
  return [...(whole.length ? [{ agent: { $in: whole } }] : []), ...models]
}

export function setupCheckReason(policies: Map<AgentName, AgentPolicyDoc>, agent: AgentName): SetupCheckReason {
  const rule = policies.get(agent)?.rule
  return rule === 'blocked' ? 'agent-blocked' : rule === 'models' ? 'model-not-listed' : 'agent-not-set'
}

/** Names, emails and team names for setup-check groups. Admins only, so every team is visible. */
async function nameGroups(viewer: JwtPayload, groups: UsageGroup[], reasonOf: (g: UsageGroup) => SetupCheckReason) {
  if (groups.length === 0) return []
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

  // Who and what only: no days, tokens or dates next to a name (v2 rule 1), and
  // sorted by name, not by how much (rule 3). The person sees their own counts on My usage.
  const rows = groups.map<SetupCheckRow>((g) => ({
    userId: g._id.userId,
    userName: userById.get(g._id.userId)?.name ?? null,
    userEmail: userById.get(g._id.userId)?.email ?? null,
    teams: (teamsOf.get(g._id.userId) ?? []).map((id) => teamName.get(id)!).sort(),
    agent: g._id.agent,
    modelName: g._id.modelName,
    reason: reasonOf(g),
  }))
  // A removed user (null name) sorts last.
  const key = (r: SetupCheckRow) => [r.userName ?? '\uffff', r.agent, r.modelName]
  return rows.sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    return x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]) || x[2].localeCompare(y[2])
  })
}

/** Usage outside the agent rules over `match`, grouped per user, agent and model. Empty when nothing can fail. */
export async function setupCheckGroups(orgId: OrgId, match: Document) {
  const store = getStore()
  const docs = await store.agentPolicies.find({ orgId })
  const branches = setupCheckBranches(docs)
  const groups = branches.length
    ? await store.usageEvents.aggregate<UsageGroup>(usageGroupPipeline({ ...match, orgId, $or: branches }))
    : []
  return { groups, byAgent: new Map(docs.map((d) => [d.agent, d])) }
}

/** Number of setup-check groups in the org over the last 30 days: the admin alert. */
export async function setupCheckCount(orgId: OrgId): Promise<number> {
  const store = getStore()
  const branches = setupCheckBranches(await store.agentPolicies.find({ orgId }))
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
  people: number
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
    { $project: { calls: 1, people: { $size: '$users' }, days: { $size: '$dates' }, lastDate: 1 } },
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
  // GET /governance/free-tier — counts only. Admins see the org, managers their own teams.
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
    const groups = await getStore().usageEvents.aggregate<ModelGroup>(freeTierPipeline(orgId, from, to, scope))
    return freeTierRows(groups)
  })

  // GET /governance/mcp — B3 inventory, counts only. Same role rules as free-tier; managers read approvals too.
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

    const approvalOf = new Map(approvals.map((a) => [a.server, a]))

    const servers = groups.map<McpServerRow>((g) => ({
      server: g._id,
      source: mcpSource(g._id),
      approved: approvalOf.has(g._id),
      note: approvalOf.get(g._id)?.note ?? null,
      people: g.people,
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

  // GET /governance/setup-checks — B2. The rules for all five agents and how
  // many people used something outside them. Admins also get the named rows
  // (v2 decision 2) and the models seen per agent for the edit form.
  fastify.get('/governance/setup-checks', async (request, reply) => {
    const { role } = request.user
    if (role !== 'admin' && role !== 'manager') {
      return reply.status(403).send({ error: 'Governance requires admin or manager role' })
    }
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const scope = await readScope(request.user, parsed.data.teamId, { adminOp: true })
    if (isRefusal(scope)) return refuse(reply, scope)
    await auditView(request, 'governance', scope, parsed.data.teamId)

    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const base = {
      orgId,
      date: { $gte: parsed.data.from as IsoDate, $lte: parsed.data.to as IsoDate },
      ...(scope && { userId: { $in: scope } }),
    }
    const [{ groups, byAgent }, seen] = await Promise.all([
      setupCheckGroups(orgId, base),
      role === 'admin'
        ? store.usageEvents.aggregate<{ _id: AgentName; models: string[] }>([
            { $match: base },
            { $group: { _id: '$agent', models: { $addToSet: '$modelName' } } },
          ])
        : [],
    ])
    return {
      policies: AGENT_NAMES.map<AgentPolicy>((agent) => {
        const d = byAgent.get(agent)
        return { agent, rule: d?.rule ?? 'unset', models: d?.models ?? [], note: d?.note ?? null }
      }),
      people: new Set(groups.map((g) => g._id.userId)).size,
      rows: role === 'admin' ? await nameGroups(request.user, groups, (g) => setupCheckReason(byAgent, g._id.agent)) : [],
      seenModels: Object.fromEntries(seen.map((s) => [s._id, [...s.models].sort()])),
    } satisfies SetupChecksResponse
  })

  // GET /governance/accounts — R2 B6. Admins only: Claude orgs and accounts
  // seen, as labels, and how many people carry each flag. No names (v2 Phase
  // 3); each person sees their own flags on My usage. Hashes are never rendered.
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
    const [docs, org, seats] = await Promise.all([
      store.claudeEnrichment.find(
        { orgId, date: { $gte: from, $lte: to }, ...inScope },
        { projection: { userId: 1, date: 1, accountHashes: 1, claudeOrgHashes: 1 } },
      ),
      store.organizations.findOne({ _id: orgId }, { projection: { ownClaudeOrgHashes: 1 } }),
      store.seats.find({ orgId, agent: 'claude', ...inScope }, { projection: { userId: 1 } }),
    ])
    const own = org?.ownClaudeOrgHashes ?? []
    const grouped = groupAccounts(docs, {
      own,
      seated: new Set(seats.map((s) => s.userId)),
      seatsEntered: seats.length,
      viewerId: request.user.userId,
    })
    const flagCounts: Record<ClaudeAccountFlag, number> = {
      shared: 0,
      'outside-org': 0,
      several: 0,
      'seat-no-use': 0,
      'use-no-seat': 0,
    }
    for (const p of grouped.people) for (const f of p.flags) flagCounts[f]++

    return {
      from,
      to,
      coverage: grouped.coverage,
      companyOrgSet: own.length > 0,
      seatsEntered: seats.length,
      companyOrgUsers: grouped.companyOrgUsers,
      orgs: grouped.orgs,
      accounts: grouped.accounts,
      flagCounts,
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

  // GET /governance/setup-checks/count — the admin alert in the nav, Overview and Governance.
  fastify.get('/governance/setup-checks/count', admin, async (request) => ({
    count: await setupCheckCount(request.user.orgId as OrgId),
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
