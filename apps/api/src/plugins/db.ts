import fp from 'fastify-plugin'
import { Pool } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-serverless'
import * as schema from '../../drizzle/schema.js'

export type DB = ReturnType<typeof drizzle<typeof schema>>

// The handle passed to a `db.transaction()` callback. Derived from `DB` rather
// than named directly so it cannot drift from the driver. Services take this so
// one implementation works inside a transaction and outside it.
export type DbOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0]

declare module 'fastify' {
  interface FastifyInstance {
    db: DB
  }
}

// One pool per process, not per plugin registration. On serverless a warm
// invocation reuses it instead of paying connection setup on every request.
// Built lazily so importing this module does not require DATABASE_URL to be
// loaded yet.
let pool: Pool | undefined

function getPool(): Pool {
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL! })
  return pool
}

// Stays on the WebSocket driver rather than neon-http: the HTTP driver cannot
// hold a transaction across statements, which usage submit needs.
export const dbPlugin = fp(async (fastify) => {
  const db = drizzle(getPool(), { schema })
  fastify.decorate('db', db)
  // Does not fire on serverless, which is what keeps the pool alive between
  // invocations. Here for local dev and test teardown.
  fastify.addHook('onClose', async () => {
    await pool?.end()
    pool = undefined
  })
})
