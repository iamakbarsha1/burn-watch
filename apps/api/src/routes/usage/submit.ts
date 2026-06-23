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

      // Verify deviceId matches JWT
      if (payload.deviceId !== jwt.deviceId) {
        return reply.status(403).send({ error: 'Device ID mismatch' })
      }

      // Upsert usage events
      const { accepted, skipped } = await upsertUsageEvents(
        fastify.db,
        jwt.userId,
        jwt.deviceId,
        payload.date,
        payload.events,
      )

      // Upsert enrichment if present
      if (payload.enrichment) {
        await upsertEnrichment(fastify.db, jwt.userId, payload.enrichment)
      }

      // Update device lastSeenAt
      await fastify.db
        .update(devices)
        .set({ lastSeenAt: new Date() })
        .where(eq(devices.id, jwt.deviceId))

      // Rebuild snapshot synchronously — only 3 queries, keeps data consistent
      try {
        await rebuildDailySnapshot(fastify.db, jwt.userId, payload.date)
      } catch (err) {
        fastify.log.error({ err, userId: jwt.userId, date: payload.date }, 'Snapshot rebuild failed')
        // Still return success for the upsert — snapshot will be rebuilt on next submission
      }

      return { accepted, skipped, date: payload.date }
    },
  )
}
