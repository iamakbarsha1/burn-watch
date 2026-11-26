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
} from '@burn-watch/db'
import { requireAdmin } from '../../plugins/jwt.js'
import { evaluateBudgetAlert } from '../../services/budget-alert.service.js'
import { audit } from '../../audit.js'

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
  // GET /budget-alerts — admin only (v2 Phase 3): every alert covers the whole
  // org or one agent, so it carries org spend. Counts only: an idle-seat alert
  // gives how many seats, a limit-hit alert how many people. Names are on the
  // admin's Unused seats card.
  fastify.get('/budget-alerts', { preHandler: requireAdmin(fastify) }, async (request) => {
    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const date = today()
    const monthKey = date.slice(0, 7)

    const alerts = await store.budgetAlerts.find({ orgId })
    const seated = await seatedKeys(store, orgId)
    const people = alerts.some((a) => a.type === 'limit-hit')
      ? ((
          await store.claudeEnrichment.aggregate<{ n: number }>([
            { $match: { orgId, date: { $gte: `${monthKey}-01` as IsoDate, $lte: date }, limitHitCount: { $gt: 0 } } },
            { $group: { _id: '$userId' } },
            { $count: 'n' },
          ])
        )[0]?.n ?? 0)
      : 0

    const result: BudgetAlert[] = await Promise.all(
      alerts.map(async (alert): Promise<BudgetAlert> => {
        const type = alert.type ?? 'api-spend'
        const spend = await monthToDateSpend(store, orgId, alert.userId, alert.agent, date, seated)
        const idle =
          type === 'idle-seat' ? await idleSeats(store, orgId, alert.userId, alert.agent, alert.idleDays ?? 1, date) : null
        const trippedMonth = alert.trippedAt ? isoMonth(alert.trippedAt) : null
        return {
          id: alert._id,
          type,
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
          idleSeatCount: idle ? idle.length : null,
          people: type === 'limit-hit' ? people : null,
        }
      }),
    )

    return result
  })

  // POST /budget-alerts — admin only. Org-wide or per agent; never one person (v2 Phase 3).
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

      const id = newId<string>()
      await store.budgetAlerts.insertOne({
        _id: id,
        orgId,
        ...typed,
        userId: null,
        agent: body.agent,
        threshold: body.threshold,
        trippedAt: null,
        createdAt: new Date(),
      })

      await evaluateBudgetAlert(store, orgId, id, today())

      await audit(request, { action: 'alert.create', target: { type: 'alert', id, label: body.type }, detail: body })
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

      // The patch as sent (USD, not micros): the fields this update applied.
      await audit(request, { action: 'alert.update', target: { type: 'alert', id, label: updated.type }, detail: patch })
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
      await audit(request, { action: 'alert.delete', target: { type: 'alert', id, label: null } })
      return { id }
    },
  )
}
