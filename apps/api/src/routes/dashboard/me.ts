import type { FastifyInstance } from 'fastify'
import { addDays, getStore, usdFromMicros, type IsoDate, type Micros, type OrgId, type UserId } from '@burn-watch/db'
import { HelpVolunteerSchema, type AgentName, type MyUsageResponse } from '@burn-watch/shared'
import { dateQuerySchema } from './query-schema.js'
import { today } from './dates.js'
import { mcpServersPipeline } from './features.js'
import { streaks } from './streaks.js'
import { WINDOW_DAYS, onboardingOf } from './onboarding.js'

const DAY_MS = 86_400_000

/**
 * v2 Phase 1: the caller's own usage. Every read is filtered to the caller's
 * own user id, so no role can reach anyone else's numbers through it. Not
 * audited: a person reading their own data is not a view of anyone.
 */
export async function meRoutes(fastify: FastifyInstance) {
  fastify.get('/me/usage', async (request, reply) => {
    const parsed = dateQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const from = (parsed.data.date ?? parsed.data.from!) as IsoDate
    const to = (parsed.data.date ?? parsed.data.to!) as IsoDate
    if (from > to) return reply.status(400).send({ error: 'Invalid query', details: 'from is after to' })
    const orgId = request.user.orgId as OrgId
    const userId = request.user.userId as UserId
    const store = getStore()

    const [inRange, activeDates, mcpRows, me] = await Promise.all([
      store.dailySnapshots.find({ orgId, userId, date: { $gte: from, $lte: to } }),
      // Streaks are all time. At most one row per day.
      store.dailySnapshots.find({ orgId, userId, totalTokens: { $gt: 0 } }, { projection: { date: 1 } }),
      store.claudeEnrichment.aggregate<{ _id: UserId; servers: string[] }>(
        mcpServersPipeline({ orgId, userIds: [userId], from, to }),
      ),
      store.users.findOne({ _id: userId, orgId }, { projection: { helpVolunteer: 1 } }),
    ])

    const byAgent = new Map<AgentName, { tokens: number; costMicros: number }>()
    let totalTokens = 0
    let sessions = 0
    let costMicros = 0
    let activeDays = 0
    for (const day of inRange) {
      totalTokens += day.totalTokens
      sessions += day.sessionCount
      costMicros += day.totalCostMicros
      // Same active-day rule as overview and trends: any tokens that day.
      if (day.totalTokens > 0) activeDays++
      for (const [agent, v] of Object.entries(day.byAgent ?? {}) as [AgentName, { tokens: number; costMicros: number }][]) {
        const sum = byAgent.get(agent) ?? { tokens: 0, costMicros: 0 }
        sum.tokens += v.tokens
        sum.costMicros += v.costMicros
        byAgent.set(agent, sum)
      }
    }
    const agents = [...byAgent]
      .filter(([, v]) => v.tokens > 0)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([agent, v]) => ({ agent, tokens: v.tokens, costUsd: usdFromMicros(v.costMicros as Micros) }))

    const dates = activeDates.map((d) => d.date)
    // Same first-sync rule as the onboarding counts: the first day with tokens.
    const firstSync = dates.length ? (dates.reduce((min, d) => (d < min ? d : min)) as IsoDate) : null
    let onboarding: MyUsageResponse['onboarding'] = null
    if (firstSync) {
      const docs = await store.claudeEnrichment.find(
        { orgId, userId, date: { $gte: firstSync, $lte: addDays(firstSync, WINDOW_DAYS - 1) } },
        {
          projection: {
            date: 1, toolUsage: 1, mcpUsage: 1, skillCounts: 1,
            sidechainMessages: 1, permissionModeCounts: 1, entrypointCounts: 1,
          },
        },
      )
      // Today's data is not synced yet, as in the streak rule.
      onboarding = { firstSync, ...onboardingOf(firstSync, dates, docs, addDays(today(), -1)) }
    }
    // "12 of 30": count from the first day ever used, so "All time" does not read "of ~2,500".
    const first = dates.reduce<string>((min, d) => (d < min ? d : min), to)
    const start = first > from ? first : from
    return {
      from,
      to,
      rangeDays: Math.round((Date.parse(to) - Date.parse(start)) / DAY_MS) + 1,
      activeDays,
      streak: streaks(dates, today()),
      totalTokens,
      sessions,
      totalCostUsd: usdFromMicros(costMicros as Micros),
      agents,
      features: { agents: agents.map((a) => a.agent), mcpServers: [...(mcpRows[0]?.servers ?? [])].sort() },
      onboarding,
      helpVolunteer: !!me?.helpVolunteer,
    } satisfies MyUsageResponse
  })

  // PUT /me/help-volunteer: the caller's own "happy to help with Claude Code".
  // Writes only the caller's flag. Not audited, like any choice a person makes about themselves.
  fastify.put('/me/help-volunteer', async (request, reply) => {
    const parsed = HelpVolunteerSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid body', details: parsed.error.flatten() })
    const { helpVolunteer } = parsed.data
    await getStore().users.updateOne(
      { _id: request.user.userId as UserId, orgId: request.user.orgId as OrgId },
      { $set: { helpVolunteer } },
    )
    return { helpVolunteer }
  })
}
