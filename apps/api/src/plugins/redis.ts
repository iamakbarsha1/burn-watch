import fp from 'fastify-plugin'
import Redis from 'ioredis'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
  }
}

// One client per process, for the same reason as the database pool.
let redis: Redis | undefined

function getRedis(): Redis {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
  redis ??= new Redis(url, { maxRetriesPerRequest: 3, retryStrategy: (times) => Math.min(times * 200, 2000) })
  return redis
}

export const redisPlugin = fp(async (fastify) => {
  fastify.decorate('redis', getRedis())
  // Does not fire on serverless. Here for local dev and test teardown.
  fastify.addHook('onClose', async () => {
    await redis?.quit()
    redis = undefined
  })
})
