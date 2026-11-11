import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { UsagePayloadSchema } from '@burn-watch/shared'
import {
  getStore,
  rebuildDailySnapshot,
  runInTxn,
  upsertEnrichment,
  upsertUsageEvents,
  type DeviceId,
  type IsoDate,
  type OrgId,
  type UserId,
} from '@burn-watch/db'
import { devices } from '../../../drizzle/schema.js'
import { requireAuth, type JwtPayload } from '../../plugins/jwt.js'
import { callerAddress } from '../../caller-address.js'
import { evaluateBudgetAlerts } from '../../services/budget-alert.service.js'

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
          // Counted per device, not per address. The default key is the
          // caller's IP, and every developer in one office shares one of those
          // — 300/hour between fifty laptops, where a single backfill sends a
          // request per day of history. `hook: 'preHandler'` is what makes it
          // possible: the rate limiter then runs after `requireAuth` above, so
          // the token has already been verified and `request.user` is real.
          // Falls back to the address for a token with no device on it, which
          // the handler rejects anyway.
          //
          // The cost of running after auth is that a request with no token is
          // answered 401 and never counted, so this route no longer caps an
          // unauthenticated flood. That is the better trade: the 401 path
          // verifies a signature and touches nothing else, while an office
          // sharing one 300/hour budget breaks real syncs every day.
          // ponytail: if an unauthenticated flood ever shows up in the logs,
          // the fix is a cheap IP cap on `onRequest` in front of this one,
          // which @fastify/rate-limit cannot express per route — it would mean
          // a small hook of its own rather than more config here.
          hook: 'preHandler',
          keyGenerator: (request: FastifyRequest) =>
            (request.user as JwtPayload | undefined)?.deviceId ?? callerAddress(request),
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

      // The token's claims and the payload's date become branded ids here and
      // nowhere deeper. This is the boundary where a string that arrived over
      // HTTP is accepted as one.
      const device = deviceId as DeviceId
      const userId = jwt.userId as UserId
      const orgId = jwt.orgId as OrgId
      const date = payload.date as IsoDate

      // One transaction. These four writes used to run independently, so a
      // failure partway through left the events stored and the snapshot stale,
      // with nothing to retry it.
      //
      // runInTxn may run this body more than once: a write conflict against
      // another rebuild of the same user-day aborts and retries from a fresh
      // snapshot. Everything in here is an upsert or a full recompute, so a
      // second run converges on the same documents and `counts` is derived
      // again from whatever that run actually wrote.
      const { accepted, skipped } = await runInTxn(getStore(), async (tx) => {
        const counts = await upsertUsageEvents(
          tx,
          userId,
          orgId,
          device,
          date,
          payload.events,
        )

        // Order no longer matters against the rebuild below. Postgres kept the
        // enrichment counters on their own table and had the rebuild read them
        // back, so this had to land first; they now go straight onto the
        // snapshot and neither write touches a field the other owns.
        //
        // `date` rather than `payload.enrichment.date`: the schema validates
        // the two separately and does not require them to agree, and this
        // write now creates a snapshot document.
        if (payload.enrichment) {
          await upsertEnrichment(tx, userId, orgId, date, payload.enrichment)
        }

        // Inside the transaction on purpose. A failed rebuild now rolls the
        // events back so the agent's retry re-submits them, instead of leaving
        // a user's spend recorded but absent from their daily snapshot.
        await rebuildDailySnapshot(tx, userId, date)

        // Same reasoning extends to the alert check: it reads the snapshot
        // this transaction just wrote, so it has to see the same commit or
        // none of it, never a version in between.
        await evaluateBudgetAlerts(tx, orgId, userId, date)

        return counts
      })

      // Held on Postgres, and deliberately outside the transaction above.
      //
      // `last_seen_at` is read back by routes/auth/device.ts — the per-user
      // max at :105-106, and the device lists at :464,484 — which feed the
      // admin and devices pages. Those are auth routes, not the dashboard
      // aggregation Phase 4 covers, so they stay on Postgres until Phase 5.
      // Writing this field to Mongo now would put it in a store nothing reads:
      // the update would match no document today, and after the Phase 7
      // backfill both pages would still render the frozen Postgres value and
      // age without bound, which reads as a dead device and invites an admin
      // to revoke a working one.
      //
      // After the commit rather than before, so it advances only for a
      // submission that actually landed — the same point the Postgres version
      // reached, where a rollback undid it. It is the last write in the
      // handler, so there is nothing after it to leave torn.
      await fastify.db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device))

      return { accepted, skipped, date: payload.date }
    },
  )
}
