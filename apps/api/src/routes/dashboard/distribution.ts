import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStore, type IsoDate, type OrgId, type UserId } from '@burn-watch/db'
import { MIN_GROUP_SIZE, type UsageBand, type UsageDistributionResponse } from '@burn-watch/shared'
import { readScope } from '../../plugins/jwt.js'
import { auditView } from '../../audit.js'
import { dateRangeFields, isRefusal, refuse, teamIdField } from './query-schema.js'

const DAY_MS = 86_400_000

const QuerySchema = z
  .object({ ...dateRangeFields, ...teamIdField })
  .refine((d) => d.from && d.to && d.from <= d.to, { message: 'Provide from+to, from not after to' })

/** Average active days per week, rounded, as a band. Any use at all is at least "1-2". */
export function usageBand(activeDays: number, rangeDays: number): UsageBand {
  if (activeDays === 0) return 'none'
  const perWeek = Math.max(1, Math.round((activeDays * 7) / Math.max(7, rangeDays)))
  return perWeek <= 2 ? '1-2' : perWeek <= 4 ? '3-4' : '5+'
}

/**
 * v2 Phase 1: how many people in scope use an agent 0, 1 to 2, 3 to 4 or 5+
 * days a week. Counts only, no names or ids. The minimum group size applies to
 * the active people counted, so an admin of a small org is refused too.
 */
export async function distributionRoutes(fastify: FastifyInstance) {
  fastify.get('/usage-distribution', async (request, reply) => {
    const { role } = request.user
    if (role !== 'admin' && role !== 'manager') {
      return reply.status(403).send({ error: 'Usage distribution requires admin or manager role' })
    }
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const from = parsed.data.from as IsoDate
    const to = parsed.data.to as IsoDate
    const { teamId } = parsed.data
    const scope = await readScope(request.user, teamId)
    if (isRefusal(scope)) return refuse(reply, scope)

    const orgId = request.user.orgId as OrgId
    const store = getStore()
    const people = await store.users.find(
      { orgId, isActive: true, ...(scope && { _id: { $in: scope } }) },
      { projection: { _id: 1 } },
    )
    if (people.length < MIN_GROUP_SIZE) return refuse(reply, 'too_small')
    await auditView(request, 'usage_distribution', scope, teamId)

    const ids = people.map((p) => p._id)
    const rows = await store.dailySnapshots.aggregate<{ _id: UserId; days: number }>([
      { $match: { orgId, userId: { $in: ids }, date: { $gte: from, $lte: to }, totalTokens: { $gt: 0 } } },
      { $group: { _id: '$userId', days: { $sum: 1 } } },
    ])
    const daysOf = new Map(rows.map((r) => [r._id, r.days]))
    const rangeDays = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1
    const bands: Record<UsageBand, number> = { none: 0, '1-2': 0, '3-4': 0, '5+': 0 }
    for (const id of ids) bands[usageBand(daysOf.get(id) ?? 0, rangeDays)]++
    return { from, to, people: ids.length, bands } satisfies UsageDistributionResponse
  })
}
