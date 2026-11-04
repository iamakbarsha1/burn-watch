import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { UsagePayloadSchema } from '@burn-watch/shared'
import { devices } from '../../../drizzle/schema.js'
import { requireAuth } from '../../plugins/jwt.js'
import { upsertUsageEvents, upsertEnrichment } from '../../services/usage.service.js'
import { rebuildDailySnapshot } from '../../services/snapshot.service.js'

export async function usageRoutes(fastify: FastifyInstance) {
  // POST /v1/usage
  fastify.post(
    '/usage',
    {
      preHandler: requireAuth(fastify),
      config: {
        rateLimit: {
          max: 300,
          timeWindow: '1 hour',
        },
      },
    },
    async (request, reply) => {
      const payload = UsagePayloadSchema.parse(request.body)
      const jwt = request.user

      // Verify deviceId matches JWT. Bound to a const so the narrowing holds
      // inside the transaction callback below — TypeScript drops narrowing of
      // a property access once it crosses into a closure. The `!deviceId` arm
      // also rejects a token that carries no device at all, which only a
      // dashboard-role token would.
      const deviceId = jwt.deviceId
      if (!deviceId || payload.deviceId !== deviceId) {
        return reply.status(403).send({ error: 'Device ID mismatch' })
      }

      // One transaction. These four writes used to run independently, so a
      // failure partway through left the events stored and the snapshot stale,
      // with nothing to retry it. Needs the WebSocket Neon driver, which cannot
      // be swapped for neon-http without losing this.
      const { accepted, skipped } = await fastify.db.transaction(async (tx) => {
        const counts = await upsertUsageEvents(
          tx,
          jwt.userId,
          deviceId,
          payload.date,
          payload.events,
        )

        if (payload.enrichment) {
          await upsertEnrichment(tx, jwt.userId, payload.enrichment)
        }

        await tx
          .update(devices)
          .set({ lastSeenAt: new Date() })
          .where(eq(devices.id, deviceId))

        // Inside the transaction on purpose. A failed rebuild now rolls the
        // events back so the agent's retry re-submits them, instead of leaving
        // a user's spend recorded but absent from their daily snapshot.
        await rebuildDailySnapshot(tx, jwt.userId, payload.date)

        return counts
      })

      return { accepted, skipped, date: payload.date }
    },
  )
}
