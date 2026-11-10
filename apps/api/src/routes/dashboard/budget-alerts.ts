import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { BudgetAlertInputSchema, BudgetAlertPatchSchema } from '@burn-watch/shared'
import type { BudgetAlert } from '@burn-watch/shared'
import {
  getStore,
  microsFromUsd,
  monthToDateSpend,
  newId,
  usdFromMicros,
  type BudgetAlertDoc,
  type IsoDate,
  type OrgId,
  type UserId,
} from '@burn-watch/db'
import { requireAdmin } from '../../plugins/jwt.js'
import { evaluateBudgetAlert } from '../../services/budget-alert.service.js'

const IdParamSchema = z.object({ id: z.string().uuid() })

function isoMonth(d: Date): string {
  return d.toISOString().slice(0, 7)
}

function today(): IsoDate {
  return new Date().toISOString().slice(0, 10) as IsoDate
}

export async function budgetAlertsRoutes(fastify: FastifyInstance) {
  // GET /budget-alerts — every threshold configured for the caller's org, with
  // live month-to-date spend and whether it is tripped this calendar month.
  // Open to every dashboard role: a developer should see why a banner is up,
  // even though only an admin can change the threshold that raised it.
  fastify.get('/budget-alerts', async (request) => {
    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const date = today()
    const monthKey = date.slice(0, 7)

    const alerts = await store.budgetAlerts.find({ orgId })

    // The left join Postgres did, as one lookup for every scoped alert rather
    // than one per alert. An id that matches no user still renders, with a null
    // name, which is what the left join gave and what keeps a deleted user from
    // hiding the limit set against them.
    const scoped = [...new Set(alerts.map((a) => a.userId).filter((id): id is UserId => id !== null))]
    const names = new Map<string, string>()
    if (scoped.length > 0) {
      for (const user of await store.users.find({ _id: { $in: scoped } }, { projection: { name: 1 } })) {
        names.set(user._id, user.name)
      }
    }

    const result: BudgetAlert[] = await Promise.all(
      alerts.map(async (alert): Promise<BudgetAlert> => {
        const spend = await monthToDateSpend(store, orgId, alert.userId, alert.agent, date)
        const trippedMonth = alert.trippedAt ? isoMonth(alert.trippedAt) : null
        return {
          id: alert._id,
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
        userId: body.userId as UserId | null,
        agent: body.agent,
        monthlyLimitMicros: microsFromUsd(body.monthlyLimitUsd),
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
