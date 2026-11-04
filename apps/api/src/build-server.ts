import 'dotenv/config'
import Fastify from 'fastify'
import type { FastifyError, FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import jwt from '@fastify/jwt'
import { ZodError } from 'zod'
import { sql } from 'drizzle-orm'
import { dbPlugin } from './plugins/db.js'
import { redisPlugin } from './plugins/redis.js'
import { authRoutes } from './routes/auth/device.js'
import { inviteRoutes } from './routes/auth/invites.js'
import { usageRoutes } from './routes/usage/submit.js'
import { dashboardRoutes } from './routes/dashboard/index.js'

/**
 * Builds the configured Fastify instance without binding a port. Serverless
 * handlers and `app.inject()` tests both need an unlistened app.
 *
 * Synchronous on purpose. `register` queues a plugin rather than loading it, so
 * nothing here needs awaiting, and that keeps the entrypoint free of top-level
 * await. Fastify resolves the queue on `ready()` or `listen()`.
 */
export function buildServer(): FastifyInstance {
  // Vitest sets NODE_ENV=test. Request logs there bury the assertion output.
  const server = Fastify({ logger: process.env.NODE_ENV !== 'test' })

  server.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation failed', details: error.flatten() })
    }
    server.log.error(error)
    return reply.status(error.statusCode ?? 500).send({ error: error.message })
  })

  // No CORS plugin on purpose. The dashboard shares an origin with the API on
  // Vercel and calls it server-side anyway; the agent is a Node CLI, which no
  // browser same-origin policy applies to. Registering CORS would only widen
  // what a browser on another origin is allowed to do.
  server.register(dbPlugin)
  // Must come before rate limit, which uses this connection as its store.
  server.register(redisPlugin)
  // Counts in Redis, not process memory. Each serverless instance keeps its own
  // in-memory counter, so the default store would multiply every per-route limit
  // by the number of live instances.
  // Inside `after` because `server.redis` does not exist until redisPlugin has
  // actually loaded, and `register` only queues. Routes are queued after this,
  // so their per-route `config.rateLimit` is still honoured.
  server.after(() => {
    server.register(rateLimit, { global: false, redis: server.redis })
  })
  server.register(jwt, { secret: process.env.JWT_SECRET!, namespace: 'access' })
  server.register(jwt, { secret: process.env.JWT_REFRESH_SECRET!, namespace: 'refresh' })

  server.register(authRoutes, { prefix: '/v1/auth' })
  server.register(inviteRoutes, { prefix: '/v1/auth' })
  server.register(usageRoutes, { prefix: '/v1' })
  server.register(dashboardRoutes, { prefix: '/v1/dashboard' })

  // Actually touches both dependencies. Returning `{ ok: true }` unconditionally
  // meant a dead database still reported healthy to Vercel and to any uptime
  // monitor. Names the failing dependency and nothing else — no connection
  // strings, no driver error text.
  server.get('/health', async (_request, reply) => {
    const checks = await Promise.allSettled([
      server.db.execute(sql`select 1`),
      server.redis.ping(),
    ])
    const failed = (['database', 'redis'] as const).filter(
      (_name, i) => checks[i].status === 'rejected',
    )

    if (failed.length > 0) {
      for (const [i, check] of checks.entries()) {
        if (check.status === 'rejected') {
          server.log.error({ err: check.reason, dependency: ['database', 'redis'][i] }, 'Health check failed')
        }
      }
      return reply.status(503).send({ ok: false, failed })
    }
    return { ok: true }
  })

  return server
}
