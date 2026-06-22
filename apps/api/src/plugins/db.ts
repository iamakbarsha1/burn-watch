import fp from 'fastify-plugin'
import { Pool } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-serverless'
import * as schema from '../../drizzle/schema.js'

type DB = ReturnType<typeof drizzle<typeof schema>>

declare module 'fastify' {
  interface FastifyInstance {
    db: DB
  }
}

export const dbPlugin = fp(async (fastify) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
  const db = drizzle(pool, { schema })
  fastify.decorate('db', db)
  fastify.addHook('onClose', async () => pool.end())
})
