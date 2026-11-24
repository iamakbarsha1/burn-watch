import type { FastifyInstance } from 'fastify'
import { getStore, usdFromMicros, type IsoDate, type Micros, type OrgId, type UserId } from '@burn-watch/db'
import type { AgentName, MyUsageResponse } from '@burn-watch/shared'
import { dateQuerySchema } from './query-schema.js'
import { today } from './dates.js'
import { mcpServersPipeline } from './features.js'
import { streaks } from './streaks.js'

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

    const [inRange, activeDates, mcpRows] = await Promise.all([
      store.dailySnapshots.find({ orgId, userId, date: { $gte: from, $lte: to } }),
      // Streaks are all time. At most one row per day.
      store.dailySnapshots.find({ orgId, userId, totalTokens: { $gt: 0 } }, { projection: { date: 1 } }),
      store.claudeEnrichment.aggregate<{ _id: UserId; servers: string[] }>(
        mcpServersPipeline({ orgId, userIds: [userId], from, to }),
      ),
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
    } satisfies MyUsageResponse
  })
}
