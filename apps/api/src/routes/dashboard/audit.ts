import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { AuditQuerySchema, type AuditMeResponse, type AuditRow, type AuditSurface } from '@burn-watch/shared'
import { getStore, type AuditEventDoc, type IsoDate, type OrgId, type TeamId, type UserId } from '@burn-watch/db'
import { requireAdmin } from '../../plugins/jwt.js'
import { auditView } from '../../audit.js'
import { daysBefore, today } from './dates.js'
import { dateRangeFields } from './query-schema.js'
import { z } from 'zod'

const startOf = (day: string) => new Date(`${day}T00:00:00.000Z`)

// GET /audit — R1 B8. Admin only, newest first. No write routes: nothing
// edits or deletes an event through the API.
export async function auditRoutes(fastify: FastifyInstance) {
  fastify.get('/audit', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    const parsed = AuditQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const q = parsed.data
    const to = (q.to ?? today()) as IsoDate
    const from = (q.from ?? daysBefore(to, 29)) as IsoDate
    const orgId = request.user.orgId as OrgId

    const filter: Filter<AuditEventDoc> = {
      orgId,
      at: { $gte: startOf(from), $lt: new Date(startOf(to).getTime() + 86_400_000) },
      ...(q.kind !== 'all' && { kind: q.kind }),
      ...(q.actorId && { actorId: q.actorId as UserId }),
      // Prefixes come from a closed list; the dot is the only regex character in them.
      ...(q.action && { action: { $regex: `^${q.action.replace('.', '\\.')}` } }),
      ...(q.targetId && { 'target.id': q.targetId }),
    }

    const store = getStore()
    const events = await store.auditEvents.find(filter, { sort: { at: -1 }, skip: q.offset, limit: q.limit })
    const ids = [...new Set(events.map((e) => e.actorId))]
    const users = ids.length
      ? await store.users.find({ _id: { $in: ids }, orgId }, { projection: { name: 1 } })
      : []
    const nameOf = new Map(users.map((u) => [u._id, u.name]))

    // Who reads the log is logged too.
    await auditView(request, 'audit', undefined)

    return events.map<AuditRow>((e) => ({
      id: e._id,
      at: e.at.toISOString(),
      lastAt: e.lastAt ? e.lastAt.toISOString() : null,
      count: e.count,
      kind: e.kind,
      action: e.action,
      actor: { id: e.actorId, name: nameOf.get(e.actorId) ?? null, role: e.actorRole },
      target: e.target,
      detail: e.detail,
    }))
  })

  // GET /audit/me — v2 Phase 4, every role. Who viewed data that covered the
  // caller, for the "Who viewed my data" section on My usage. Not audited: a
  // person reading about themselves is not a view of anyone.
  fastify.get('/audit/me', async (request, reply) => {
    const parsed = z.object(dateRangeFields).safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    const to = (parsed.data.to ?? today()) as IsoDate
    // The full year view rows are kept for (VIEW_RETENTION_MS in audit.ts).
    const from = (parsed.data.from ?? daysBefore(to, 364)) as IsoDate
    if (from > to) return reply.status(400).send({ error: 'Invalid query', details: 'from is after to' })
    const orgId = request.user.orgId as OrgId
    const me = request.user.userId as UserId
    const store = getStore()

    const mine = await store.teamMembers.find({ orgId, userId: me })
    const teamIds = [...new Set(mine.map((m) => m.teamId))]
    const managers = teamIds.length
      ? await store.teamMembers.find({ orgId, teamId: { $in: teamIds as TeamId[] }, role: 'manager' })
      : []
    const managerIds = [...new Set(managers.map((m) => m.userId))]

    const events = await store.auditEvents.find(
      {
        orgId,
        kind: 'view',
        actorId: { $ne: me },
        at: { $gte: startOf(from), $lt: new Date(startOf(to).getTime() + 86_400_000) },
        $or: [
          // v2.1 rows say who they covered at the time.
          { coveredUserIds: me },
          // Older rows do not, so they go by the teams the caller is in today.
          {
            coveredUserIds: { $exists: false },
            $or: [
              { 'target.type': 'scope', 'target.label': 'org' },
              ...(teamIds.length ? [{ 'target.type': 'team' as const, 'target.id': { $in: teamIds } }] : []),
              ...(managerIds.length
                ? [{ 'target.type': 'scope' as const, 'target.label': 'managed teams', actorId: { $in: managerIds } }]
                : []),
            ],
          },
        ],
      },
      // One row per viewer, surface and day: a year of daily views by a few
      // people fits. shortcut: older rows past 1000 are cut, page it if an org hits that.
      { sort: { at: -1 }, limit: 1000 },
    )
    const ids = [...new Set(events.map((e) => e.actorId))]
    const users = ids.length ? await store.users.find({ _id: { $in: ids }, orgId }, { projection: { name: 1 } }) : []
    const nameOf = new Map(users.map((u) => [u._id, u.name]))

    return {
      from,
      to,
      rows: events.map((e) => ({
        at: e.at.toISOString(),
        lastAt: e.lastAt ? e.lastAt.toISOString() : null,
        count: e.count,
        surface: e.action.slice('view.'.length) as AuditSurface,
        viewer: { name: nameOf.get(e.actorId) ?? null, role: e.actorRole },
        scope: e.target.label,
      })),
    } satisfies AuditMeResponse
  })
}
