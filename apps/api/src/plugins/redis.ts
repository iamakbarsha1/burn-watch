import fp from 'fastify-plugin'
import Redis from 'ioredis'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
  }
}

// One client per process, for the same reason as the database pool.
let redis: Redis | undefined

// ioredis does not reject a URL it cannot understand — it silently falls back to
// localhost:6379, so a REST-style Upstash URL (https://...) or an empty value
// surfaces much later as `ECONNREFUSED 127.0.0.1:6379` on a host that never ran
// a Redis. That cost a deploy to diagnose. Fail at boot with the actual reason
// instead, and never dial localhost anywhere but a developer machine.
function resolveRedisUrl(): string {
  const url = process.env.REDIS_URL

  if (!url) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('REDIS_URL is not set. Refusing to fall back to localhost in production.')
    }
    return 'redis://localhost:6379'
  }

  const scheme = url.split('://')[0]
  if (scheme !== 'redis' && scheme !== 'rediss') {
    throw new Error(
      `REDIS_URL must be a redis:// or rediss:// URL, got "${scheme}://". ` +
        'Upstash exposes both a REST endpoint and a TCP endpoint; ioredis needs the TCP one.',
    )
  }

  // A localhost URL copied from a developer .env passes every check above and
  // then fails in production as ECONNREFUSED 127.0.0.1:6379, which reads like a
  // missing variable rather than a wrong one. Name it for what it is.
  const host = new URL(url).hostname
  if (process.env.NODE_ENV === 'production' && (host === 'localhost' || host === '127.0.0.1')) {
    throw new Error(
      `REDIS_URL points at ${host}, which cannot be reached in production. ` +
        'It looks like a local development value. Set it to the Upstash TCP URL.',
    )
  }

  return url
}

function getRedis(): Redis {
  const url = resolveRedisUrl()
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
