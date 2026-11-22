import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import { z } from 'zod'
import {
  addDays,
  getStore,
  idleSeats,
  seatCost,
  seatLastUsed,
  seatedKeys,
  usdFromMicros,
  type IsoDate,
  type Micros,
  type OrgId,
  type TeamId,
  type UserId,
} from '@burn-watch/db'
import {
  IdleSeatsQuerySchema,
  type AgentName,
  type FunnelCounts,
  type FunnelResponse,
  type FunnelStop,
  type IdleSeatRow,
  type IdleSeatsResponse,
  type StuckPerson,
} from '@burn-watch/shared'
import { comparableTeams, readScope } from '../../plugins/jwt.js'
import { dateRangeFields, scopeError, teamIdField } from './query-schema.js'
import { today } from './dates.js'

const DAY_MS = 86_400_000
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS

const FunnelQuerySchema = z
  .object({ ...dateRangeFields, ...teamIdField })
  .refine((d) => d.from && d.to && d.from <= d.to, { message: 'Provide from+to, from not after to' })

/** The A3 stage thresholds for a range: Decision 2 scales "2 days" and "5 of 7 days" to its length. */
export function funnelThresholds(from: IsoDate, to: IsoDate) {
  const rangeDays = daysBetween(from, to) + 1
  return { rangeDays, activeDays: Math.min(2, rangeDays), powerDays: Math.ceil((rangeDays * 5) / 7) }
}
type Thresholds = ReturnType<typeof funnelThresholds>

/** One person in the funnel: an active user, or an unused invite with no user behind it. */
export interface FunnelPerson {
  userId: UserId | null
  name: string | null
  /** Set for an invite only. */
  email: string | null
  /** Visible teams only. */
  teamIds: TeamId[]
  /** Invite sent, or account created. */
  since: IsoDate
  hasDevice: boolean
  /** First and last day with tokens, all time. */
  firstSync: IsoDate | null
  lastSync: IsoDate | null
  /** Days with tokens inside the range. */
  activeDays: number
}

const STAGES = ['invited', 'registered', 'firstSync', 'active', 'powerUser'] as const
type Stage = (typeof STAGES)[number]

/** The last stage a person reached. Each stage implies the one before. */
export function stageOf(p: FunnelPerson, t: Thresholds): Stage {
  if (!p.userId) return 'invited'
  if (!p.firstSync) return 'registered'
  if (p.activeDays < t.activeDays) return 'firstSync'
  return p.activeDays < t.powerDays ? 'active' : 'powerUser'
}

export function countFunnel(people: FunnelPerson[], t: Thresholds): FunnelCounts {
  const c: FunnelCounts = { invited: 0, registered: 0, deviceLinked: 0, firstSync: 0, active: 0, powerUser: 0 }
  for (const p of people) {
    for (const s of STAGES.slice(0, STAGES.indexOf(stageOf(p, t)) + 1)) c[s]++
    if (p.userId && p.hasDevice) c.deviceLinked++
  }
  return c
}

/** Everyone short of power user, by stopping point, then by name. */
export function stuckList(people: FunnelPerson[], t: Thresholds, teamName: Map<TeamId, string>): StuckPerson[] {
  return people
    .flatMap<StuckPerson>((p) => {
      const stage = stageOf(p, t)
      if (stage === 'powerUser') return []
      return [
        {
          stoppedAt: stage as FunnelStop,
          userId: p.userId,
          name: p.name,
          email: p.email,
          teams: p.teamIds.map((id) => teamName.get(id)!).sort(),
          lastStepDate: stage === 'invited' || stage === 'registered' ? p.since : p.lastSync!,
        },
      ]
    })
    .sort(
      (a, b) =>
        STAGES.indexOf(a.stoppedAt) - STAGES.indexOf(b.stoppedAt) ||
        (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? ''),
    )
}

interface FunnelUserRow {
  userId: UserId
  name: string
  createdAt: Date
  hasDevice: boolean
  firstSync: IsoDate | null
  lastSync: IsoDate | null
  activeDays: number
}

/**
 * Active users in scope with device and usage facts, one row each. The two
 * `$lookup`s mirror `adminUsersPipeline`; zero-token days are not syncs.
 */
export function funnelUsersPipeline(orgId: OrgId, from: IsoDate, to: IsoDate, userIds?: UserId[]): Document[] {
  return [
    { $match: { orgId, isActive: true, ...(userIds && { _id: { $in: userIds } }) } },
    {
      $lookup: {
        from: 'devices',
        localField: '_id',
        foreignField: 'userId',
        pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }],
        as: 'devices',
      },
    },
    {
      $lookup: {
        from: 'dailySnapshots',
        localField: '_id',
        foreignField: 'userId',
        pipeline: [
          { $match: { totalTokens: { $gt: 0 } } },
          {
            $group: {
              _id: null,
              firstSync: { $min: '$date' },
              lastSync: { $max: '$date' },
              activeDays: {
                $sum: { $cond: [{ $and: [{ $gte: ['$date', from] }, { $lte: ['$date', to] }] }, 1, 0] },
              },
            },
          },
        ],
        as: 'usage',
      },
    },
    { $set: { usage: { $first: '$usage' } } },
    {
      $project: {
        _id: 0,
        userId: '$_id',
        name: '$name',
        createdAt: '$createdAt',
        hasDevice: { $gt: [{ $size: '$devices' }, 0] },
        firstSync: { $ifNull: ['$usage.firstSync', null] },
        lastSync: { $ifNull: ['$usage.lastSync', null] },
        activeDays: { $ifNull: ['$usage.activeDays', 0] },
      },
    },
  ]
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10) as IsoDate

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

  // GET /adoption/funnel — A3. Read only, so no audit event.
  fastify.get('/adoption/funnel', async (request, reply) => {
    const { role } = request.user
    if (role !== 'admin' && role !== 'manager') {
      return reply.status(403).send({ error: 'Adoption requires admin or manager role' })
    }
    const parsed = FunnelQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const from = parsed.data.from as IsoDate
    const to = parsed.data.to as IsoDate
    const { teamId } = parsed.data
    const scope = await readScope(request.user, teamId)
    if (scope === 403 || scope === 404) return reply.status(scope).send(scopeError(scope))

    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const [rows, teams, invites, firstDay] = await Promise.all([
      store.users.aggregate<FunnelUserRow>(funnelUsersPipeline(orgId, from, to, scope)),
      comparableTeams(request.user),
      // Newest first, so a repeat invite keeps the latest team.
      store.invites.find({ orgId, usedAt: null }, { sort: { createdAt: -1 } }),
      store.dailySnapshots.find(
        { orgId, totalTokens: { $gt: 0 } },
        { projection: { date: 1 }, sort: { date: 1 }, limit: 1 },
      ),
    ])
    // Clamp the range start to the org's first usage day, so "All time" does
    // not set the power threshold at ~1,800 days. No rows exist before it.
    const first = firstDay[0]?.date as IsoDate | undefined
    const start = first && first > from && first <= to ? first : from
    const teamName = new Map(teams.map((t) => [t._id, t.name]))
    const ids = rows.map((r) => r.userId)
    const members =
      ids.length && teams.length
        ? await store.teamMembers.find({ orgId, teamId: { $in: [...teamName.keys()] }, userId: { $in: ids } })
        : []
    const teamsOf = new Map<UserId, TeamId[]>()
    for (const m of members) {
      if (!ids.includes(m.userId) || !teamName.has(m.teamId)) continue
      teamsOf.set(m.userId, [...(teamsOf.get(m.userId) ?? []), m.teamId])
    }

    // An invite counts only while no user in the org has its email, once per
    // email, in the scope's teams: a manager never sees a No-team invite.
    const open = invites.filter((i) =>
      teamId ? i.teamId === teamId : role === 'admin' || (!!i.teamId && teamName.has(i.teamId)),
    )
    const taken = new Set(
      open.length ? (await store.users.find({ orgId }, { projection: { email: 1 } })).map((u) => u.email.toLowerCase()) : [],
    )
    const people: FunnelPerson[] = rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      email: null,
      teamIds: teamsOf.get(r.userId) ?? [],
      since: isoDay(r.createdAt),
      hasDevice: r.hasDevice,
      firstSync: r.firstSync,
      lastSync: r.lastSync,
      activeDays: r.activeDays,
    }))
    for (const i of open) {
      const email = i.email.toLowerCase()
      if (taken.has(email)) continue
      taken.add(email)
      people.push({
        userId: null,
        name: null,
        email,
        teamIds: i.teamId && teamName.has(i.teamId) ? [i.teamId] : [],
        since: isoDay(i.createdAt),
        hasDevice: false,
        firstSync: null,
        lastSync: null,
        activeDays: 0,
      })
    }

    const t = funnelThresholds(start, to)
    return {
      from: start,
      to,
      ...t,
      total: countFunnel(people, t),
      teams: teams
        .filter((team) => !teamId || team._id === teamId)
        .map((team) => ({
          teamId: team._id,
          teamName: team.name,
          ...countFunnel(people.filter((p) => p.teamIds.includes(team._id)), t),
        })),
      noTeam: role === 'admin' && !teamId ? countFunnel(people.filter((p) => p.teamIds.length === 0), t) : null,
      stuck: stuckList(people, t, teamName),
    } satisfies FunnelResponse
  })
}
