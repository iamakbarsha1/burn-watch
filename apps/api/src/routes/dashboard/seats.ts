import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AgentNameSchema, SeatAssignAllSchema, SeatInputSchema, type Seat } from '@burn-watch/shared'
import {
  getStore,
  microsFromUsd,
  runInTxn,
  seatKey,
  usdFromMicros,
  type IsoDate,
  type OrgId,
  type UserId,
} from '@burn-watch/db'
import { requireAdmin } from '../../plugins/jwt.js'
import { evaluateSeatAlerts } from '../../services/budget-alert.service.js'
import { today } from './dates.js'

const SeatParams = z.object({ userId: z.string().uuid(), agent: AgentNameSchema })

// Every route here is admin only, and every write re-checks the org's
// api-spend and idle-seat alerts in the same transaction: a seat changes which
// usage is API spend and which seat is idle.
export async function seatsRoutes(fastify: FastifyInstance) {
  const admin = { preHandler: requireAdmin(fastify) }

  // GET /seats — every seat in the org, with the holder's name and email.
  fastify.get('/seats', admin, async (request) => {
    const store = getStore()
    const orgId = request.user.orgId as OrgId
    const seats = await store.seats.find({ orgId }, { sort: { userId: 1, agent: 1 } })
    const ids = [...new Set(seats.map((s) => s.userId))]
    const users = ids.length
      ? await store.users.find({ _id: { $in: ids }, orgId }, { projection: { name: 1, email: 1 } })
      : []
    const byId = new Map(users.map((u) => [u._id, u]))
    return seats.map<Seat>((s) => ({
      userId: s.userId,
      userName: byId.get(s.userId)?.name ?? null,
      userEmail: byId.get(s.userId)?.email ?? null,
      agent: s.agent,
      monthlyPriceUsd: usdFromMicros(s.monthlyPriceMicros),
      startDate: s.startDate,
      createdAt: s.createdAt.toISOString(),
    }))
  })

  // PUT /seats/:userId/:agent — add or update one seat.
  fastify.put('/seats/:userId/:agent', admin, async (request, reply) => {
    const { userId, agent } = SeatParams.parse(request.params)
    const body = SeatInputSchema.parse(request.body)
    const store = getStore()
    const orgId = request.user.orgId as OrgId

    // Same check budget-alerts POST does: never seat another org's user.
    if (!(await store.users.findOne({ _id: userId as UserId, orgId }))) {
      return reply.status(400).send({ error: 'User not found in this organization' })
    }

    await runInTxn(store, async (tx) => {
      await tx.seats.updateOne(
        { _id: seatKey(userId as UserId, agent) },
        {
          $set: { monthlyPriceMicros: microsFromUsd(body.monthlyPriceUsd), startDate: body.startDate as IsoDate },
          $setOnInsert: { orgId, userId: userId as UserId, agent, createdAt: new Date() },
        },
        { upsert: true },
      )
      await evaluateSeatAlerts(tx, orgId, today())
    })
    return { userId, agent }
  })

  // DELETE /seats/:userId/:agent — another org's seat deletes nothing and answers 404.
  fastify.delete('/seats/:userId/:agent', admin, async (request, reply) => {
    const { userId, agent } = SeatParams.parse(request.params)
    const orgId = request.user.orgId as OrgId
    const deleted = await runInTxn(getStore(), async (tx) => {
      const n = await tx.seats.deleteOne({ _id: seatKey(userId as UserId, agent), orgId })
      if (n > 0) await evaluateSeatAlerts(tx, orgId, today())
      return n
    })
    if (deleted === 0) return reply.status(404).send({ error: 'Seat not found' })
    return { userId, agent }
  })

  // POST /seats/assign-all — a seat for every active user without one on this
  // agent. Never overwrites: $setOnInsert only, so re-running it when someone
  // joins fills the gap and leaves every existing price alone.
  fastify.post('/seats/assign-all', admin, async (request) => {
    const body = SeatAssignAllSchema.parse(request.body)
    const store = getStore()
    const orgId = request.user.orgId as OrgId

    const created = await runInTxn(store, async (tx) => {
      const users = await tx.users.find({ orgId, isActive: true }, { projection: { _id: 1 } })
      const held = new Set((await tx.seats.find({ orgId, agent: body.agent })).map((s) => s.userId))
      const missing = users.filter((u) => !held.has(u._id))
      if (missing.length === 0) return 0
      const now = new Date()
      const r = await tx.seats.bulkWrite(
        missing.map((u) => ({
          updateOne: {
            filter: { _id: seatKey(u._id, body.agent) },
            update: {
              $setOnInsert: {
                orgId,
                userId: u._id,
                agent: body.agent,
                monthlyPriceMicros: microsFromUsd(body.monthlyPriceUsd),
                startDate: body.startDate as IsoDate,
                createdAt: now,
              },
            },
            upsert: true,
          },
        })),
      )
      await evaluateSeatAlerts(tx, orgId, today())
      return r.upsertedCount
    })
    return { created }
  })
}
