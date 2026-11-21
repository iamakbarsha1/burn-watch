import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { BudgetAlertInputSchema, BudgetAlertPatchSchema } from '@burn-watch/shared'
import type { BudgetAlert } from '@burn-watch/shared'
import {
  getStore,
  idleSeats,
  microsFromUsd,
  monthToDateSpend,
  newId,
  seatedKeys,
  usdFromMicros,
  type BudgetAlertDoc,
  type IsoDate,
  type OrgId,
  type UserId,
} from '@burn-watch/db'
import { requireAdmin, viewerScope } from '../../plugins/jwt.js'
import { evaluateBudgetAlert } from '../../services/budget-alert.service.js'

const IdParamSchema = z.object({ id: z.string().uuid() })

function isoMonth(d: Date): string {
  return d.toISOString().slice(0, 7)
}

function today(): IsoDate {
  return new Date().toISOString().slice(0, 10) as IsoDate
}

type TypedFields = Pick<BudgetAlertDoc, 'type' | 'monthlyLimitMicros' | 'idleDays' | 'limitHits'>

/** What the alert's type is missing, or null. Run on the merged alert so create and patch agree. */
function typeError(a: TypedFields): string | null {
  if (a.type === 'api-spend' && !(a.monthlyLimitMicros > 0)) return 'api-spend alerts need monthlyLimitUsd'
  if (a.type === 'idle-seat' && a.idleDays === null) return 'idle-seat alerts need idleDays'
  if (a.type === 'limit-hit' && a.limitHits === null) return 'limit-hit alerts need limitHits'
  return null
}

export async function budgetAlertsRoutes(fastify: FastifyInstance) {
  // GET /budget-alerts — every threshold configured for the caller's org, with
  // live month-to-date spend and whether it is tripped this calendar month.
  // Open to every dashboard role, but a non-admin only gets alerts set on
  // their own account: an org-wide one carries the whole org's spend.
  fastify.get('/budget-alerts', async (request) => {
    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const date = today()
    const monthKey = date.slice(0, 7)

    const userIds = await viewerScope(request.user)
    const alerts = await store.budgetAlerts.find({ orgId, ...(userIds && { userId: { $in: userIds } }) })

    const idleByAlert = new Map(
      await Promise.all(
        alerts
          .filter((a) => a.type === 'idle-seat')
          .map(async (a) => [a._id, await idleSeats(store, orgId, a.userId, a.agent, a.idleDays ?? 1, date)] as const),
      ),
    )
    const idleUsers = [...idleByAlert.values()].flat().map((seat) => seat.userId)

    // The left join Postgres did, as one lookup for every scoped alert rather
    // than one per alert. An id that matches no user still renders, with a null
    // name, which is what the left join gave and what keeps a deleted user from
    // hiding the limit set against them.
    //
    // `orgId` is in the filter where the Postgres join had nothing: PATCH
    // accepts a userId without checking its org (POST does check), so an alert
    // in this org can carry another org's user id and this lookup would
    // otherwise resolve that user's name into the response. Scoping the read
    // renders it as null instead. The PATCH hole itself predates this phase
    // and is left for its own change.
    const scoped = [
      ...new Set([...alerts.map((a) => a.userId), ...idleUsers].filter((id): id is UserId => id !== null)),
    ]
    const names = new Map<string, string>()
    if (scoped.length > 0) {
      const found = await store.users.find(
        { _id: { $in: scoped }, orgId },
        { projection: { name: 1 } },
      )
      for (const user of found) names.set(user._id, user.name)
    }

    const seated = await seatedKeys(store, orgId)

    const result: BudgetAlert[] = await Promise.all(
      alerts.map(async (alert): Promise<BudgetAlert> => {
        const type = alert.type ?? 'api-spend'
        const spend = await monthToDateSpend(store, orgId, alert.userId, alert.agent, date, seated)
        const idle = idleByAlert.get(alert._id) ?? null
        const trippedMonth = alert.trippedAt ? isoMonth(alert.trippedAt) : null
        return {
          id: alert._id,
          type,
          userId: alert.userId,
          userName: alert.userId ? names.get(alert.userId) ?? null : null,
          agent: alert.agent,
          // Micros travel as far as this line and no further. Everything below
          // a handler works in whole micros; dollars exist for the wire.
          monthlyLimitUsd: usdFromMicros(alert.monthlyLimitMicros),
          threshold: alert.threshold,
          createdAt: alert.createdAt.toISOString(),
          trippedAt: alert.trippedAt ? alert.trippedAt.toISOString() : null,
          tripped: trippedMonth === monthKey,
          monthToDateSpendUsd: usdFromMicros(spend),
          idleDays: alert.idleDays ?? null,
          limitHits: alert.limitHits ?? null,
          idleSeats:
            idle?.map((seat) => ({ userId: seat.userId, userName: names.get(seat.userId) ?? null, agent: seat.agent })) ??
            null,
        }
      }),
    )

    return result
  })

  // POST /budget-alerts — admin only. A userId has to belong to the caller's
  // own org, the same check POST /v1/auth/admin/users applies.
  fastify.post(
    '/budget-alerts',
    { preHandler: requireAdmin(fastify) },
    async (request, reply) => {
      const body = BudgetAlertInputSchema.parse(request.body)
      const store = getStore()
      const orgId = request.user.orgId as OrgId

      // Fields of the other types are stored null (0 for the limit), so a doc
      // never carries a figure that does not apply to it.
      const typed: TypedFields = {
        type: body.type,
        monthlyLimitMicros: microsFromUsd(body.type === 'api-spend' ? (body.monthlyLimitUsd ?? 0) : 0),
        idleDays: body.type === 'idle-seat' ? body.idleDays : null,
        limitHits: body.type === 'limit-hit' ? body.limitHits : null,
      }
      const invalid = typeError(typed)
      if (invalid) return reply.status(400).send({ error: invalid })

      if (body.userId) {
        const user = await store.users.findOne({ _id: body.userId as UserId, orgId })
        if (!user) {
          return reply.status(400).send({ error: 'User not found in this organization' })
        }
      }

      const id = newId<string>()
      await store.budgetAlerts.insertOne({
        _id: id,
        orgId,
        ...typed,
        userId: body.userId as UserId | null,
        agent: body.agent,
        threshold: body.threshold,
        trippedAt: null,
        createdAt: new Date(),
      })

      await evaluateBudgetAlert(store, orgId, id, today())

      return reply.status(201).send({ id })
    },
  )

  // PATCH /budget-alerts/:id — admin only. An alert in another org answers
  // 404, one answer for "no such alert" and "not yours", same as the device
  // revoke lookup.
  fastify.patch(
    '/budget-alerts/:id',
    { preHandler: requireAdmin(fastify) },
    async (request, reply) => {
      const { id } = IdParamSchema.parse(request.params)
      const patch = BudgetAlertPatchSchema.parse(request.body)
      const store = getStore()
      const orgId = request.user.orgId as OrgId

      // Never empty: the schema refuses a patch with no fields, because an
      // empty one would be a successful no-op that looks like a saved change.
      const values: Partial<BudgetAlertDoc> = {}
      if (patch.userId !== undefined) values.userId = patch.userId as UserId | null
      if (patch.agent !== undefined) values.agent = patch.agent
      if (patch.monthlyLimitUsd !== undefined) {
        values.monthlyLimitMicros = microsFromUsd(patch.monthlyLimitUsd)
      }
      if (patch.threshold !== undefined) values.threshold = patch.threshold
      if (patch.type !== undefined) values.type = patch.type
      if (patch.idleDays !== undefined) values.idleDays = patch.idleDays
      if (patch.limitHits !== undefined) values.limitHits = patch.limitHits

      // Checked against the stored alert merged with the patch, so switching
      // type without the field the new type needs is a 400, not a broken alert.
      if (values.type || values.idleDays !== undefined || values.limitHits !== undefined) {
        const current = await store.budgetAlerts.findOne({ _id: id, orgId })
        if (!current) return reply.status(404).send({ error: 'Budget alert not found' })
        const invalid = typeError({
          type: values.type ?? current.type ?? 'api-spend',
          monthlyLimitMicros: values.monthlyLimitMicros ?? current.monthlyLimitMicros,
          idleDays: values.idleDays !== undefined ? values.idleDays : (current.idleDays ?? null),
          limitHits: values.limitHits !== undefined ? values.limitHits : (current.limitHits ?? null),
        })
        if (invalid) return reply.status(400).send({ error: invalid })
      }

      const updated = await store.budgetAlerts.findOneAndUpdate({ _id: id, orgId }, { $set: values })

      if (!updated) {
        return reply.status(404).send({ error: 'Budget alert not found' })
      }

      await evaluateBudgetAlert(store, orgId, id, today())

      return { id }
    },
  )

  // DELETE /budget-alerts/:id — admin only, same org-scoped lookup.
  fastify.delete(
    '/budget-alerts/:id',
    { preHandler: requireAdmin(fastify) },
    async (request, reply) => {
      const { id } = IdParamSchema.parse(request.params)
      const store = getStore()
      const orgId = request.user.orgId as OrgId

      const deleted = await store.budgetAlerts.deleteOne({ _id: id, orgId })
      if (deleted === 0) {
        return reply.status(404).send({ error: 'Budget alert not found' })
      }
      return { id }
    },
  )
}
