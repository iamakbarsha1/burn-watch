import fp from 'fastify-plugin'
import Redis from 'ioredis'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
  }
}

export const redisPlugin = fp(async (fastify) => {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const redis = new Redis(url, { maxRetriesPerRequest: 3, retryStrategy: (times) => Math.min(times * 200, 2000) })
  fastify.decorate('redis', redis)
  fastify.addHook('onClose', async () => redis.quit())
})
