import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import jwt from '@fastify/jwt'
import { dbPlugin } from './plugins/db.js'
import { redisPlugin } from './plugins/redis.js'
import { authRoutes } from './routes/auth/device.js'
import { usageRoutes } from './routes/usage/submit.js'
import { dashboardRoutes } from './routes/dashboard/index.js'

const server = Fastify({ logger: true })

await server.register(cors, { origin: process.env.CORS_ORIGIN ?? '*' })
await server.register(rateLimit, { global: false })
await server.register(jwt, { secret: process.env.JWT_SECRET! })
await server.register(dbPlugin)
await server.register(redisPlugin)

await server.register(authRoutes, { prefix: '/v1/auth' })
await server.register(usageRoutes, { prefix: '/v1' })
await server.register(dashboardRoutes, { prefix: '/v1/dashboard' })

server.get('/health', async () => ({ ok: true }))

const port = Number(process.env.PORT) || 3001
await server.listen({ port, host: '0.0.0.0' })
