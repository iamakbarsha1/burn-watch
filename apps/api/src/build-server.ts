import 'dotenv/config'
import Fastify from 'fastify'
import type { FastifyError, FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import jwt from '@fastify/jwt'
import { ZodError } from 'zod'
import { sql } from 'drizzle-orm'
import { assertSchemaCurrent as assertMongoSchemaCurrent, pingDb } from '@burn-watch/db'
import { dbPlugin } from './plugins/db.js'
import { pgRateLimitStore } from './plugins/rate-limit-store.js'
import { callerAddress } from './caller-address.js'
import { assertSchemaCurrent } from './schema-version.js'
import { authRoutes } from './routes/auth/device.js'
import { inviteRoutes } from './routes/auth/invites.js'
import { usageRoutes } from './routes/usage/submit.js'
import { dashboardRoutes } from './routes/dashboard/index.js'
import { copilotIntegrationRoutes } from './routes/integrations/copilot.js'

/**
 * Registers everything onto an existing instance. Takes the instance rather
 * than creating it so the entrypoint can own the `Fastify()` call: Vercel's
 * adapter rejects an entrypoint that does not import fastify directly, failing
 * the build with "No entrypoint found which imports fastify".
 *
 * Synchronous on purpose. `register` queues a plugin rather than loading it, so
 * nothing here needs awaiting, and that keeps the entrypoint free of top-level
 * await. Fastify resolves the queue on `ready()` or `listen()`.
 */
export function configureServer(server: FastifyInstance): FastifyInstance {
  server.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation failed', details: error.flatten() })
    }
    server.log.error(error)
    const status = error.statusCode ?? 500
    // Under 500, whoever threw chose the status and wrote the message for the
    // caller: Fastify's own auth and rate-limit text, or a route's deliberate
    // client error. At 500 the message is whatever failed, and a database
    // driver's names tables, columns, constraints and sometimes row values.
    // The dashboard renders `error` in the browser, so that text stays in
    // the log above and nowhere else.
    return reply
      .status(status)
      .send({ error: status < 500 ? error.message : 'Internal server error' })
  })

  // No CORS plugin on purpose, and that survives the API moving to its own
  // origin in a separate project. The dashboard calls this from its own Node
  // process, so no browser ever issues the request; the agent is a Node CLI,
  // which no same-origin policy applies to. Registering CORS would only widen
  // what a browser on another origin is allowed to do.
  server.register(dbPlugin)
  // Counters live in Postgres, not in process memory. The default store counts
  // per instance, so every per-route cap below was really N times its stated
  // value across N warm serverless instances — device registration at 3/hour
  // was 3N/hour. `skipOnError` stays at its default of false: a counter the
  // database cannot write is not a reason to wave the request through.
  server.register(rateLimit, {
    global: false,
    store: pgRateLimitStore(() => server.db),
    keyGenerator: callerAddress,
  })
  server.register(jwt, { secret: process.env.JWT_SECRET!, namespace: 'access' })
  server.register(jwt, { secret: process.env.JWT_REFRESH_SECRET!, namespace: 'refresh' })

  server.register(authRoutes, { prefix: '/v1/auth' })
  server.register(inviteRoutes, { prefix: '/v1/auth' })
  server.register(usageRoutes, { prefix: '/v1' })
  server.register(dashboardRoutes, { prefix: '/v1/dashboard' })
  server.register(copilotIntegrationRoutes, { prefix: '/v1/integrations' })

  // Actually touches the database. Returning `{ ok: true }` unconditionally
  // meant a dead database still reported healthy to Vercel and to any uptime
  // monitor. Names the failing dependency and nothing else — no connection
  // strings, no driver error text. Still a list so adding a dependency back
  // does not change the response shape.
  // `schema` is the second check for the reason BW-37 records: a reachable
  // database running an older schema than the code is an outage this endpoint
  // used to call healthy. Checked in the same list so one failure still
  // reports on the other.
  // `mongo` and `mongoSchema` join it now that Phase 2 gives this process its
  // first MongoDB dependency. The second of the two matters more here than it
  // does for postgres: a missing index fails no query at all, it only stops
  // the usage upsert deduplicating, so nothing but a live shape check would
  // ever notice.
  server.get('/health', async (_request, reply) => {
    const names = ['database', 'schema', 'mongo', 'mongoSchema'] as const
    const checks = await Promise.allSettled([
      server.db.execute(sql`select 1`),
      assertSchemaCurrent(server.db),
      pingDb(),
      assertMongoSchemaCurrent(),
    ])
    const failed = names.filter((_name, i) => checks[i].status === 'rejected')

    if (failed.length > 0) {
      for (const [i, check] of checks.entries()) {
        if (check.status === 'rejected') {
          server.log.error({ err: check.reason, dependency: names[i] }, 'Health check failed')
        }
      }
      return reply.status(503).send({ ok: false, failed })
    }
    return { ok: true }
  })

  return server
}

/**
 * Convenience factory for tests and anything that does not need to listen.
 * Vitest sets NODE_ENV=test; request logs there bury the assertion output.
 */
export function buildServer(): FastifyInstance {
  return configureServer(Fastify({ logger: process.env.NODE_ENV !== 'test' }))
}
