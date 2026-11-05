import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { pgRateLimitStore } from './rate-limit-store.js'
import type { DB } from './db.js'

const dialect = new PgDialect()

/**
 * Records what was asked for and hands back whatever the test queued. Only
 * `execute` is ever called, so the cast is narrower than it looks.
 */
function fakeDb(rows: Record<string, unknown>[]) {
  const queries: { text: string; params: unknown[] }[] = []
  const db = {
    execute(query: SQL) {
      const { sql, params } = dialect.sqlToQuery(query)
      queries.push({ text: sql, params })
      return Promise.resolve({ rows })
    },
  }
  return { db: db as unknown as DB, queries }
}

const incr = (Store: ReturnType<typeof pgRateLimitStore>, key: string, timeWindow: number) =>
  new Promise<{ current: number; ttl: number }>((resolve, reject) => {
    new Store().incr(key, (err, res) => (err ? reject(err) : resolve(res!)), timeWindow)
  })

describe('pgRateLimitStore', () => {
  it('returns the count and remaining window the upsert reported', async () => {
    const { db, queries } = fakeDb([{ count: 4, ttl: 1800000 }])

    const result = await incr(pgRateLimitStore(() => db), '1.2.3.4', 3_600_000)

    expect(result).toEqual({ current: 4, ttl: 1800000 })
    expect(queries[0].params).toEqual(['1.2.3.4', 3_600_000])
    expect(queries[0].text).toContain('on conflict (key) do update')
  })

  it('counts each route separately', async () => {
    const { db, queries } = fakeDb([{ count: 1, ttl: 900000 }])
    const Store = pgRateLimitStore(() => db)

    const child = new Store().child({
      routeInfo: { method: 'POST', url: '/v1/auth/register-device' },
    })
    await new Promise<void>((resolve, reject) => {
      child.incr('1.2.3.4', (err) => (err ? reject(err) : resolve()), 900_000)
    })

    expect(queries[0].params[0]).toBe('POST/v1/auth/register-device-1.2.3.4')
  })

  it('fails the request when the counter cannot be read', async () => {
    const db = { execute: () => Promise.reject(new Error('connection terminated')) }

    await expect(
      incr(pgRateLimitStore(() => db as unknown as DB), '1.2.3.4', 1000),
    ).rejects.toThrow('connection terminated')
  })
})
