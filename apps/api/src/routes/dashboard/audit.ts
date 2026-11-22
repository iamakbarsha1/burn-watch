import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { AuditQuerySchema, type AuditRow } from '@burn-watch/shared'
import { getStore, type AuditEventDoc, type IsoDate, type OrgId, type UserId } from '@burn-watch/db'
import { requireAdmin } from '../../plugins/jwt.js'
import { auditView } from '../../audit.js'
import { daysBefore, today } from './dates.js'

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
}
