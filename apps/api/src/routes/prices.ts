import type { FastifyInstance } from 'fastify'
import { PRICE_TABLE } from '@burn-watch/shared/prices'

// The table's version is the cache key: it changes only when the table does.
const ETAG = `"${PRICE_TABLE.version}"`

export async function priceRoutes(fastify: FastifyInstance) {
  // GET /v1/prices. Public on purpose: model list prices from an MIT-licensed
  // file, nothing about any user, and an agent whose token lapsed should
  // still price its usage right. The agent fetches it at most once a day.
  fastify.get(
    '/prices',
    { config: { rateLimit: { max: 120, timeWindow: '1 hour' } } },
    async (request, reply) => {
      reply.header('ETag', ETAG).header('Cache-Control', 'public, max-age=86400')
      if (request.headers['if-none-match'] === ETAG) return reply.status(304).send()
      return PRICE_TABLE
    },
  )
}
