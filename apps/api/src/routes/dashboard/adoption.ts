import type { FastifyInstance } from 'fastify'
import {
  addDays,
  getStore,
  idleSeats,
  seatCost,
  seatLastUsed,
  seatedKeys,
  usdFromMicros,
  type Micros,
  type OrgId,
  type TeamId,
  type UserId,
} from '@burn-watch/db'
import { IdleSeatsQuerySchema, type AgentName, type IdleSeatRow, type IdleSeatsResponse } from '@burn-watch/shared'
import { comparableTeams, readScope } from '../../plugins/jwt.js'
import { scopeError } from './query-schema.js'
import { today } from './dates.js'

const DAY_MS = 86_400_000
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS

export async function adoptionRoutes(fastify: FastifyInstance) {
  // GET /adoption/idle-seats — A1. Admins see the org, managers their own teams.
  fastify.get('/adoption/idle-seats', async (request, reply) => {
    const { role } = request.user
    if (role !== 'admin' && role !== 'manager') {
      return reply.status(403).send({ error: 'Adoption requires admin or manager role' })
    }
    const parsed = IdleSeatsQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const { idleDays, teamId } = parsed.data
    const scope = await readScope(request.user, teamId)
    if (scope === 403 || scope === 404) return reply.status(scope).send(scopeError(scope))

    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const date = today()
    const inScope = scope && new Set(scope)
    const [idle, orgSeats] = await Promise.all([
      idleSeats(store, orgId, null, null, idleDays, date),
      role === 'admin' ? seatedKeys(store, orgId).then((s) => s.size) : null,
    ])
    const seats = idle.filter((s) => !inScope || inScope.has(s.userId))
    const ids = [...new Set(seats.map((s) => s.userId))]

    const [lastUsed, users, teams] = await Promise.all([
      seatLastUsed(store, orgId, ids),
      ids.length ? store.users.find({ _id: { $in: ids }, orgId }, { projection: { name: 1 } }) : [],
      ids.length ? comparableTeams(request.user) : [],
    ])
    const members = teams.length
      ? await store.teamMembers.find({ orgId, teamId: { $in: teams.map((t) => t._id) }, userId: { $in: ids } })
      : []

    // Team names only from teams the viewer may see, as on Governance.
    const nameOf = new Map(users.map((u) => [u._id, u.name]))
    const teamName = new Map(teams.map((t) => [t._id, t.name]))
    const teamsOf = new Map<UserId, TeamId[]>()
    for (const m of members) {
      if (!ids.includes(m.userId) || !teamName.has(m.teamId)) continue
      teamsOf.set(m.userId, [...(teamsOf.get(m.userId) ?? []), m.teamId])
    }

    const rows = seats
      .map<IdleSeatRow>((s) => {
        const last = lastUsed.get(s._id) ?? null
        // Use before the seat started does not make the seat idle earlier than its start.
        const afterLast = last && addDays(last, 1)
        const idleSince = afterLast && afterLast > s.startDate ? afterLast : s.startDate
        return {
          userId: s.userId,
          userName: nameOf.get(s.userId) ?? null,
          teams: (teamsOf.get(s.userId) ?? []).map((id) => teamName.get(id)!).sort(),
          agent: s.agent,
          startDate: s.startDate,
          lastUsed: last,
          daysIdle: daysBetween(idleSince, date) + 1,
          monthlyPriceUsd: usdFromMicros(s.monthlyPriceMicros),
          costSinceUsedUsd: usdFromMicros(seatCost(s, idleSince, date, date)),
        }
      })
      .sort((a, b) => b.daysIdle - a.daysIdle || a.agent.localeCompare(b.agent))

    // Sum in micros, so the totals carry no float drift.
    const byAgent = new Map<AgentName, { seats: number; micros: number }>()
    const byTeam = new Map<TeamId, { seats: number; micros: number }>()
    const add = <K>(m: Map<K, { seats: number; micros: number }>, k: K, micros: number) => {
      const t = m.get(k) ?? { seats: 0, micros: 0 }
      m.set(k, { seats: t.seats + 1, micros: t.micros + micros })
    }
    for (const s of seats) {
      add(byAgent, s.agent, s.monthlyPriceMicros)
      for (const t of teamsOf.get(s.userId) ?? []) add(byTeam, t, s.monthlyPriceMicros)
    }
    const total = seats.reduce((sum, s) => sum + s.monthlyPriceMicros, 0)

    return {
      idleDays,
      rows,
      byAgent: [...byAgent]
        .map(([agent, t]) => ({ agent, seats: t.seats, monthlyUsd: usdFromMicros(t.micros as Micros) }))
        .sort((a, b) => b.monthlyUsd - a.monthlyUsd),
      byTeam: [...byTeam]
        .map(([teamId, t]) => ({
          teamId,
          teamName: teamName.get(teamId)!,
          seats: t.seats,
          monthlyUsd: usdFromMicros(t.micros as Micros),
        }))
        .sort((a, b) => b.monthlyUsd - a.monthlyUsd),
      totalMonthlyUsd: usdFromMicros(total as Micros),
      orgSeats,
    } satisfies IdleSeatsResponse
  })
}
