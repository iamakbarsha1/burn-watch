import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { BudgetAlertInputSchema, BudgetAlertPatchSchema } from '@burn-watch/shared'
import type { BudgetAlert, AgentName } from '@burn-watch/shared'
import { budgetAlerts, users } from '../../../drizzle/schema.js'
import { requireAdmin, viewerScope } from '../../plugins/jwt.js'
import { monthToDateSpend, evaluateBudgetAlert } from '../../services/budget-alert.service.js'

const IdParamSchema = z.object({ id: z.string().uuid() })

function isoMonth(d: Date): string {
  return d.toISOString().slice(0, 7)
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function budgetAlertsRoutes(fastify: FastifyInstance) {
  // GET /budget-alerts — every threshold configured for the caller's org, with
  // live month-to-date spend and whether it is tripped this calendar month.
  // Open to every dashboard role, but a non-admin only gets alerts set on
  // their own account: an org-wide one carries the whole org's spend.
  fastify.get('/budget-alerts', async (request) => {
    const orgId = request.user.orgId
    const userId = viewerScope(request.user)
    const date = today()
    const monthKey = date.slice(0, 7)

    const rows = await fastify.db
      .select({
        id: budgetAlerts.id,
        userId: budgetAlerts.userId,
        userName: users.name,
        agent: budgetAlerts.agent,
        monthlyLimitUsd: budgetAlerts.monthlyLimitUsd,
        threshold: budgetAlerts.threshold,
        createdAt: budgetAlerts.createdAt,
        trippedAt: budgetAlerts.trippedAt,
      })
      .from(budgetAlerts)
      .leftJoin(users, eq(users.id, budgetAlerts.userId))
      .where(
        and(eq(budgetAlerts.orgId, orgId), userId ? eq(budgetAlerts.userId, userId) : undefined),
      )

    const result: BudgetAlert[] = await Promise.all(
      rows.map(async (row): Promise<BudgetAlert> => {
        const spend = await monthToDateSpend(fastify.db, orgId, row.userId, row.agent, date)
        const trippedMonth = row.trippedAt ? isoMonth(row.trippedAt) : null
        return {
          id: row.id,
          userId: row.userId,
          userName: row.userName,
          agent: row.agent as AgentName | null,
          monthlyLimitUsd: Number(row.monthlyLimitUsd),
          threshold: Number(row.threshold),
          createdAt: row.createdAt.toISOString(),
          trippedAt: row.trippedAt ? row.trippedAt.toISOString() : null,
          tripped: trippedMonth === monthKey,
          monthToDateSpendUsd: spend,
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
      const orgId = request.user.orgId

      if (body.userId) {
        const [user] = await fastify.db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, body.userId), eq(users.orgId, orgId)))
        if (!user) {
          return reply.status(400).send({ error: 'User not found in this organization' })
        }
      }

      const [created] = await fastify.db
        .insert(budgetAlerts)
        .values({
          orgId,
          userId: body.userId,
          agent: body.agent,
          monthlyLimitUsd: String(body.monthlyLimitUsd),
          threshold: String(body.threshold),
        })
        .returning({ id: budgetAlerts.id })

      await evaluateBudgetAlert(fastify.db, orgId, created.id, today())

      return reply.status(201).send({ id: created.id })
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
      const orgId = request.user.orgId

      const values: Record<string, unknown> = {}
      if (patch.userId !== undefined) values.userId = patch.userId
      if (patch.agent !== undefined) values.agent = patch.agent
      if (patch.monthlyLimitUsd !== undefined) values.monthlyLimitUsd = String(patch.monthlyLimitUsd)
      if (patch.threshold !== undefined) values.threshold = String(patch.threshold)

      const [updated] = await fastify.db
        .update(budgetAlerts)
        .set(values)
        .where(and(eq(budgetAlerts.id, id), eq(budgetAlerts.orgId, orgId)))
        .returning({ id: budgetAlerts.id })

      if (!updated) {
        return reply.status(404).send({ error: 'Budget alert not found' })
      }

      await evaluateBudgetAlert(fastify.db, orgId, updated.id, today())

      return { id: updated.id }
    },
  )

  // DELETE /budget-alerts/:id — admin only, same org-scoped lookup.
  fastify.delete(
    '/budget-alerts/:id',
    { preHandler: requireAdmin(fastify) },
    async (request, reply) => {
      const { id } = IdParamSchema.parse(request.params)
      const orgId = request.user.orgId

      const [deleted] = await fastify.db
        .delete(budgetAlerts)
        .where(and(eq(budgetAlerts.id, id), eq(budgetAlerts.orgId, orgId)))
        .returning({ id: budgetAlerts.id })

      if (!deleted) {
        return reply.status(404).send({ error: 'Budget alert not found' })
      }
      return { id: deleted.id }
    },
  )
}
