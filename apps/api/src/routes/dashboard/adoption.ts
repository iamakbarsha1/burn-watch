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
  PRACTICE_RANKS,
  type AgentName,
  type FeatureMatrixResponse,
  type FeaturePerson,
  type FunnelCounts,
  type FunnelResponse,
  type FunnelStop,
  type IdleSeatRow,
  type IdleSeatsResponse,
  type OnboardingPerson,
  type OnboardingResponse,
  type PracticesResponse,
  type TeamChampions,
  type StuckPerson,
} from '@burn-watch/shared'
import { comparableTeams, readScope } from '../../plugins/jwt.js'
import { auditView } from '../../audit.js'
import { dateRangeFields, scopeError, teamIdField } from './query-schema.js'
import { today } from './dates.js'
import { countFeatures, featureDays, type FeatureFields } from './features.js'
import type { EnrichmentRange } from './enrichment.js'
import { leaderboardSettings, mcpServersPipeline, scoreAll } from './leaderboard.js'
import { MIN_QUARTILE_PEOPLE, practiceGroup, practiceTips, quartileSplit, suggestChampions } from './quartile.js'
import { streaks } from './streaks.js'
import {
  ACTIVE_DAYS_PER_WEEK,
  MIN_FEATURES,
  MIN_FOR_PERCENT,
  WINDOW_DAYS,
  countOnboarding,
  onboardingOf,
} from './onboarding.js'

const DAY_MS = 86_400_000
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS

const FunnelQuerySchema = z
  .object({ ...dateRangeFields, ...teamIdField })
  .refine((d) => d.from && d.to && d.from <= d.to, { message: 'Provide from+to, from not after to' })

const PracticesQuerySchema = z
  .object({ ...dateRangeFields, ...teamIdField, rankBy: z.enum(PRACTICE_RANKS).default('days') })
  .refine((d) => d.from && d.to && d.from <= d.to, { message: 'Provide from+to, from not after to' })

/** A5's enrichment days per person in range: one doc per person per day. */
async function readFeatureDays(orgId: OrgId, from: IsoDate, to: IsoDate, scope: UserId[] | undefined) {
  const docs = await getStore().claudeEnrichment.find(
    { orgId, date: { $gte: from, $lte: to }, ...(scope && { userId: { $in: scope } }) },
    {
      projection: {
        userId: 1, date: 1, toolUsage: 1, mcpUsage: 1, skillCounts: 1,
        sidechainMessages: 1, permissionModeCounts: 1, entrypointCounts: 1,
      },
    },
  )
  const daysOf = new Map<UserId, (FeatureFields & { date: IsoDate })[]>()
  for (const d of docs) daysOf.set(d.userId, [...(daysOf.get(d.userId) ?? []), d])
  return daysOf
}

/**
 * R2 A6 Decision 3: Claude tokens and cache tokens per person from usageEvents,
 * since `dailySnapshots.cacheHitRate` has suspect zero days and a mean of daily
 * rates is not the rate over the range.
 */
export function claudeTokensPipeline({ orgId, userIds, from, to }: EnrichmentRange): Document[] {
  return [
    { $match: { orgId, agent: 'claude', date: { $gte: from, $lte: to }, ...(userIds && { userId: { $in: userIds } }) } },
    {
      $group: {
        _id: '$userId',
        tokens: { $sum: '$totalTokens' },
        read: { $sum: '$cacheReadTokens' },
        cacheable: { $sum: { $add: ['$inputTokens', '$cacheCreateTokens', '$cacheReadTokens'] } },
      },
    },
  ]
}

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
    await auditView(request, 'adoption', scope, teamId)

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

  // GET /adoption/funnel — A3.
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
    await auditView(request, 'adoption', scope, teamId)

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

  // R2 A5. Who used MCP, skills, subagents, plan mode and the SDK in range.
  fastify.get('/adoption/features', async (request, reply) => {
    const { role, userId: viewerId } = request.user
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
    await auditView(request, 'adoption', scope, teamId)

    const store = getStore()
    const orgId = request.user.orgId as OrgId
    // One enrichment doc per person per day, so a person's doc count is their active days.
    const [daysOf, teams] = await Promise.all([readFeatureDays(orgId, from, to, scope), comparableTeams(request.user)])
    const ids = [...daysOf.keys()]
    const teamName = new Map(teams.map((t) => [t._id, t.name]))
    const [users, members] = ids.length
      ? await Promise.all([
          store.users.find({ orgId, isActive: true, _id: { $in: ids } }, { projection: { name: 1, hideOnLeaderboard: 1 } }),
          teams.length
            ? store.teamMembers.find({ orgId, teamId: { $in: [...teamName.keys()] }, userId: { $in: ids } })
            : Promise.resolve([]),
        ])
      : [[], []]
    const teamsOf = new Map<UserId, TeamId[]>()
    for (const m of members) {
      if (!daysOf.has(m.userId) || !teamName.has(m.teamId)) continue
      teamsOf.set(m.userId, [...(teamsOf.get(m.userId) ?? []), m.teamId])
    }

    const people: FeaturePerson[] = users.map((u) => ({
      userId: u._id,
      // Decision 5: the leaderboard's "Hide my name" holds here too, except for admins and yourself.
      name: role !== 'admin' && u._id !== viewerId && u.hideOnLeaderboard ? 'Hidden' : u.name,
      teamIds: teamsOf.get(u._id) ?? [],
      activeDays: daysOf.get(u._id)!.length,
      days: featureDays(daysOf.get(u._id)!),
    }))
    const usedCount = (p: FeaturePerson) => Object.values(p.days).filter((n) => (n ?? 0) > 0).length
    people.sort((a, b) => usedCount(b) - usedCount(a) || a.name.localeCompare(b.name))

    return {
      from,
      to,
      total: countFeatures(people),
      teams: teams
        .filter((team) => !teamId || team._id === teamId)
        .map((team) => ({
          teamId: team._id,
          teamName: team.name,
          ...countFeatures(people.filter((p) => p.teamIds.includes(team._id))),
        })),
      noTeam: role === 'admin' && !teamId ? countFeatures(people.filter((p) => p.teamIds.length === 0)) : null,
      people,
    } satisfies FeatureMatrixResponse
  })

  // R2 D6. New people in range and whether they got going in their first 14 days.
  fastify.get('/adoption/onboarding', async (request, reply) => {
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
    await auditView(request, 'adoption', scope, teamId)

    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const [rows, teams] = await Promise.all([
      store.users.aggregate<FunnelUserRow>(funnelUsersPipeline(orgId, from, to, scope)),
      comparableTeams(request.user),
    ])
    // Decision 3: the cohort is people whose first sync is in range.
    const cohort = rows.filter((r): r is FunnelUserRow & { firstSync: IsoDate } => !!r.firstSync && r.firstSync >= from && r.firstSync <= to)
    const ids = cohort.map((r) => r.userId)
    const teamName = new Map(teams.map((t) => [t._id, t.name]))
    const first = cohort.reduce<IsoDate>((min, r) => (r.firstSync < min ? r.firstSync : min), to)
    const last = addDays(to, WINDOW_DAYS - 1)
    const [snapshots, daysOf, members] = ids.length
      ? await Promise.all([
          store.dailySnapshots.find(
            { orgId, userId: { $in: ids }, date: { $gte: first, $lte: last }, totalTokens: { $gt: 0 } },
            { projection: { userId: 1, date: 1 } },
          ),
          readFeatureDays(orgId, first, last, ids),
          teams.length
            ? store.teamMembers.find({ orgId, teamId: { $in: [...teamName.keys()] }, userId: { $in: ids } })
            : Promise.resolve([]),
        ])
      : [[], new Map(), []]
    const datesOf = new Map<UserId, string[]>()
    for (const s of snapshots) datesOf.set(s.userId, [...(datesOf.get(s.userId) ?? []), s.date])
    const teamsOf = new Map<UserId, TeamId[]>()
    for (const m of members) {
      if (!teamName.has(m.teamId)) continue
      teamsOf.set(m.userId, [...(teamsOf.get(m.userId) ?? []), m.teamId])
    }

    // Today's data is not synced yet, as in the streak rule.
    const lastSynced = addDays(today(), -1)
    const people: OnboardingPerson[] = cohort.map((r) => ({
      userId: r.userId,
      name: r.name,
      teamIds: teamsOf.get(r.userId) ?? [],
      firstSync: r.firstSync,
      ...onboardingOf(r.firstSync, datesOf.get(r.userId) ?? [], daysOf.get(r.userId) ?? [], lastSynced),
    }))

    return {
      from,
      to,
      activeDaysPerWeek: ACTIVE_DAYS_PER_WEEK,
      minFeatures: MIN_FEATURES,
      minForPercent: MIN_FOR_PERCENT,
      total: countOnboarding(people),
      teams: teams
        .filter((team) => !teamId || team._id === teamId)
        .map((team) => ({
          teamId: team._id,
          teamName: team.name,
          ...countOnboarding(people.filter((p) => p.teamIds.includes(team._id))),
        })),
      noTeam: role === 'admin' && !teamId ? countOnboarding(people.filter((p) => p.teamIds.length === 0)) : null,
      // Decision 6: the people to help, with names, like A3's stuck list. Newest first.
      people: people
        .filter((p) => p.state === 'missed' || p.state === 'inProgress')
        .sort((a, b) => (a.firstSync < b.firstSync ? 1 : a.firstSync > b.firstSync ? -1 : a.name.localeCompare(b.name))),
    } satisfies OnboardingResponse
  })

  // R2 A6. The top quartile of Claude Code users against the rest. Aggregates only.
  fastify.get('/adoption/practices', async (request, reply) => {
    const { role, userId: viewerId } = request.user
    if (role !== 'admin' && role !== 'manager') {
      return reply.status(403).send({ error: 'Adoption requires admin or manager role' })
    }
    const parsed = PracticesQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const from = parsed.data.from as IsoDate
    const to = parsed.data.to as IsoDate
    const { teamId, rankBy } = parsed.data
    const scope = await readScope(request.user, teamId)
    if (scope === 403 || scope === 404) return reply.status(scope).send(scopeError(scope))
    await auditView(request, 'adoption', scope, teamId)

    const store = getStore()
    const orgId = request.user.orgId as OrgId
    // Same population as A5: active users with a Claude Code day in range.
    const daysOf = await readFeatureDays(orgId, from, to, scope)
    const ids = [...daysOf.keys()]
    const [active, teams, settings] = await Promise.all([
      ids.length
        ? store.users.find({ orgId, isActive: true, _id: { $in: ids } }, { projection: { name: 1, hideOnLeaderboard: 1 } })
        : Promise.resolve([]),
      comparableTeams(request.user),
      leaderboardSettings(orgId),
    ])
    const userIds = active.map((u) => u._id)
    // A7 privacy: as the leaderboard, names off hides everyone from a manager.
    const namesOff = role !== 'admin' && !settings.showNames
    const base = { from, to, rankBy, population: userIds.length, minPopulation: MIN_QUARTILE_PEOPLE, namesOff }
    if (userIds.length === 0) return { ...base, top: null, rest: null, tips: [], champions: [] } satisfies PracticesResponse

    const range = { orgId, userIds, from, to }
    const [tokenRows, mcpRows, snapshots] = await Promise.all([
      store.usageEvents.aggregate<{ _id: UserId; tokens: number; read: number; cacheable: number }>(claudeTokensPipeline(range)),
      store.claudeEnrichment.aggregate<{ _id: UserId; servers: string[] }>(mcpServersPipeline(range)),
      // The A8 score needs all-time active days for the streak; read only when asked for.
      rankBy === 'score'
        ? store.dailySnapshots.find(
            { orgId, userId: { $in: userIds }, totalTokens: { $gt: 0 } },
            { projection: { userId: 1, date: 1, totalTokens: 1, byAgent: 1 } },
          )
        : Promise.resolve([]),
    ])
    const tokensOf = new Map(tokenRows.map((r) => [r._id, r]))
    const serversOf = new Map(mcpRows.map((r) => [r._id, r.servers.length]))

    // Decision 1: the A8 score within this population, so tops are this scope's tops.
    const scoreOf = new Map<UserId, number>()
    if (rankBy === 'score') {
      const now = today()
      const parts = userIds.map((id) => {
        const mine = snapshots.filter((s) => s.userId === id)
        const inRange = mine.filter((s) => s.date >= from && s.date <= to)
        const agents = new Set(
          inRange.flatMap((s) => Object.entries(s.byAgent ?? {}).filter(([, v]) => (v?.tokens ?? 0) > 0).map(([k]) => k)),
        )
        return {
          activeDays: inRange.length,
          streak: streaks(mine.map((s) => s.date), now).current,
          tokens: inRange.reduce((sum, s) => sum + s.totalTokens, 0),
          features: agents.size + (serversOf.get(id) ?? 0),
        }
      })
      scoreAll(parts).forEach((score, i) => scoreOf.set(userIds[i], score))
    }

    const people = active.map((u) => {
      const userId = u._id
      const t = tokensOf.get(userId)
      const docs = daysOf.get(userId)!
      const tokens = t?.tokens ?? 0
      return {
        userId,
        name: u.name,
        // A7 Decision 3: you are never hidden from yourself.
        hidden: !!u.hideOnLeaderboard && userId !== viewerId,
        tokens,
        rank: rankBy === 'days' ? docs.length : rankBy === 'tokens' ? tokens : scoreOf.get(userId) ?? 0,
        activeDays: docs.length,
        days: featureDays(docs),
        mcpServers: serversOf.get(userId) ?? 0,
        cacheHitRate: t && t.cacheable > 0 ? (t.read / t.cacheable) * 100 : null,
      }
    })
    // R2 A7: champions per visible team, shown even below the A6 minimum.
    const champions: TeamChampions[] = []
    if (!namesOff) {
      const visible = teams.filter((team) => !teamId || team._id === teamId)
      const members = visible.length
        ? await store.teamMembers.find({ orgId, teamId: { $in: visible.map((t) => t._id) }, userId: { $in: userIds } })
        : []
      const groups: { teamId: TeamId | null; teamName: string; ids: Set<string> }[] = visible.map((team) => ({
        teamId: team._id,
        teamName: team.name,
        ids: new Set(members.filter((m) => m.teamId === team._id).map((m) => m.userId)),
      }))
      if (role === 'admin' && !teamId) {
        const inTeam = new Set(members.map((m) => m.userId))
        groups.push({ teamId: null, teamName: 'No team', ids: new Set(userIds.filter((id) => !inTeam.has(id))) })
      }
      for (const g of groups) {
        const team = people.filter((p) => g.ids.has(p.userId))
        const { reason, champions: picked } = suggestChampions(team, role !== 'admin')
        champions.push({
          teamId: g.teamId,
          teamName: g.teamName,
          users: team.length,
          reason,
          champions: picked.map(({ person, uses, canHelpWith }) => ({
            userId: person.userId,
            name: person.name,
            activeDays: person.activeDays,
            hidden: person.hidden,
            uses,
            canHelpWith,
          })),
        })
      }
    }

    const split = quartileSplit(people)
    if (!split) return { ...base, top: null, rest: null, tips: [], champions } satisfies PracticesResponse
    const top = practiceGroup(split.top)
    const rest = practiceGroup(split.rest)
    return { ...base, top, rest, tips: practiceTips(top, rest), champions } satisfies PracticesResponse
  })
}
