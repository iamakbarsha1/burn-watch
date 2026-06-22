import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import jwt from '@fastify/jwt'
import { ZodError } from 'zod'
import { dbPlugin } from './plugins/db.js'
import { redisPlugin } from './plugins/redis.js'
import { authRoutes } from './routes/auth/device.js'
import { usageRoutes } from './routes/usage/submit.js'
import { dashboardRoutes } from './routes/dashboard/index.js'

const server = Fastify({ logger: true })

server.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) {
    return reply.status(400).send({ error: 'Validation failed', details: error.flatten() })
  }
  server.log.error(error)
  return reply.status(error.statusCode ?? 500).send({ error: error.message })
})

if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
  throw new Error('CORS_ORIGIN must be set in production')
}
await server.register(cors, { origin: process.env.CORS_ORIGIN ?? '*' })
await server.register(rateLimit, { global: false })
await server.register(jwt, { secret: process.env.JWT_SECRET!, namespace: 'access' })
await server.register(jwt, { secret: process.env.JWT_REFRESH_SECRET!, namespace: 'refresh' })
await server.register(dbPlugin)
await server.register(redisPlugin)

await server.register(authRoutes, { prefix: '/v1/auth' })
await server.register(usageRoutes, { prefix: '/v1' })
await server.register(dashboardRoutes, { prefix: '/v1/dashboard' })

server.get('/health', async () => ({ ok: true }))

const shutdown = async (signal: string) => {
  server.log.info(`${signal} received, shutting down`)
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

const port = Number(process.env.PORT) || 3001
await server.listen({ port, host: '0.0.0.0' })
