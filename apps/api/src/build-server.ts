import 'dotenv/config'
import Fastify from 'fastify'
import type { FastifyError, FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import jwt from '@fastify/jwt'
import { ZodError } from 'zod'
import { sql } from 'drizzle-orm'
import { dbPlugin } from './plugins/db.js'
import { authRoutes } from './routes/auth/device.js'
import { inviteRoutes } from './routes/auth/invites.js'
import { usageRoutes } from './routes/usage/submit.js'
import { dashboardRoutes } from './routes/dashboard/index.js'

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
    return reply.status(error.statusCode ?? 500).send({ error: error.message })
  })

  // No CORS plugin on purpose, and that survives the API moving to its own
  // origin in a separate project. The dashboard calls this from its own Node
  // process, so no browser ever issues the request; the agent is a Node CLI,
  // which no same-origin policy applies to. Registering CORS would only widen
  // what a browser on another origin is allowed to do.
  server.register(dbPlugin)
  // ponytail: in-memory counters, per instance. Every per-route limit below is
  // effectively multiplied by the number of live serverless instances, which
  // matters because all of them guard auth endpoints — device registration is
  // 3/hour on one instance and 3N/hour on N. Redis backed this with a shared
  // counter until the cache was dropped for the MVP. Restore a shared store
  // (Redis, or a Postgres table keyed by ip+route) before this API is reachable
  // by anyone outside the company.
  server.register(rateLimit, { global: false })
  server.register(jwt, { secret: process.env.JWT_SECRET!, namespace: 'access' })
  server.register(jwt, { secret: process.env.JWT_REFRESH_SECRET!, namespace: 'refresh' })

  server.register(authRoutes, { prefix: '/v1/auth' })
  server.register(inviteRoutes, { prefix: '/v1/auth' })
  server.register(usageRoutes, { prefix: '/v1' })
  server.register(dashboardRoutes, { prefix: '/v1/dashboard' })

  // Actually touches the database. Returning `{ ok: true }` unconditionally
  // meant a dead database still reported healthy to Vercel and to any uptime
  // monitor. Names the failing dependency and nothing else — no connection
  // strings, no driver error text. Still a list so adding a dependency back
  // does not change the response shape.
  server.get('/health', async (_request, reply) => {
    const checks = await Promise.allSettled([server.db.execute(sql`select 1`)])
    const failed = (['database'] as const).filter((_name, i) => checks[i].status === 'rejected')

    if (failed.length > 0) {
      for (const [i, check] of checks.entries()) {
        if (check.status === 'rejected') {
          server.log.error({ err: check.reason, dependency: ['database'][i] }, 'Health check failed')
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
