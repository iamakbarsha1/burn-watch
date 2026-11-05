import { sql } from 'drizzle-orm'
import type { RouteOptions } from 'fastify'
import type { DB } from './db.js'

type IncrResult = { current: number; ttl: number }
type IncrCallback = (error: Error | null, result?: IncrResult) => void

// Rows are only rewritten when the same key comes back, so a caller that never
// returns leaves its last row behind. The sweep is an index range scan that
// usually deletes nothing, so it runs on a counter rather than on every request.
// ponytail: fixed count, switch to a time check if traffic ever puts 500
// requests inside one window.
const SWEEP_EVERY = 500

/**
 * A `@fastify/rate-limit` store backed by the `rate_limits` table.
 *
 * The default store keeps counters in process memory. That is wrong on
 * serverless: N warm instances give every route N independent counters, so a
 * 3/hour device-registration cap is really 3N/hour. One row per route+caller in
 * Postgres gives the whole deployment a single counter.
 *
 * Takes a getter rather than the handle so the store can be built while
 * `server.db` is still being decorated by `dbPlugin`.
 */
export function pgRateLimitStore(getDb: () => DB) {
  let sinceSweep = 0

  return class PgRateLimitStore {
    // The plugin calls `new Store(globalParams)`; `prefix` is only ever passed
    // by `child` below.
    constructor(
      _options?: unknown,
      readonly prefix = '',
    ) {}

    // `timeWindow` is always supplied by the plugin. It carries a default only
    // so the signature stays assignable to the store interface the package
    // ships, which declares `incr(key, callback)` and omits the two arguments
    // the runtime actually passes.
    incr(key: string, cb: IncrCallback, timeWindow = 60_000): void {
      const db = getDb()
      // One statement: insert the first hit, or bump the existing count unless
      // its window has already closed, in which case start a fresh one. Doing
      // the expiry check in the UPDATE rather than deleting first keeps this
      // atomic against a concurrent request for the same key.
      db.execute(sql`
        insert into rate_limits (key, count, expires_at)
        values (
          ${this.prefix + key},
          1,
          now() + ${timeWindow}::double precision * interval '1 millisecond'
        )
        on conflict (key) do update set
          count = case when rate_limits.expires_at <= now() then 1 else rate_limits.count + 1 end,
          expires_at = case when rate_limits.expires_at <= now() then excluded.expires_at else rate_limits.expires_at end
        returning count, ceil(extract(epoch from (expires_at - now())) * 1000)::int as ttl
      `).then(
        (result) => {
          const row = result.rows[0] as { count: number; ttl: number } | undefined
          if (!row) return cb(new Error('rate_limits upsert returned no row'))

          if (++sinceSweep >= SWEEP_EVERY) {
            sinceSweep = 0
            // Best effort. A failed sweep leaves dead rows, which costs disk
            // and nothing else, and it must not fail the request it rode in on.
            void db.execute(sql`delete from rate_limits where expires_at < now()`).catch(() => {})
          }

          cb(null, { current: Number(row.count), ttl: Number(row.ttl) })
        },
        (err: Error) => cb(err),
      )
    }

    // One counter per route, the way the package's own Redis store scopes keys.
    // Without this every rate-limited route would share a single row per caller.
    // `routeInfo` is optional here because the shipped types describe the
    // argument as a plain route options object and omit it; losing it would
    // merge every route onto one counter, which only tightens the limits.
    child(routeOptions: Partial<RouteOptions> & { routeInfo?: { method: string; url: string } }) {
      const route = routeOptions.routeInfo
      return new PgRateLimitStore(undefined, route ? `${route.method}${route.url}-` : '')
    }
  }
}
