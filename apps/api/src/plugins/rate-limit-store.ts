import type { Document } from 'mongodb'
import type { RouteOptions } from 'fastify'
import { getStore } from '@burn-watch/db'

type IncrResult = { current: number; ttl: number }
type IncrCallback = (error: Error | null, result?: IncrResult) => void

/**
 * The update for one hit. A missing document or a closed window starts a fresh
 * window at 1; otherwise the count goes up and the window keeps its end.
 * Every field in one `$set` reads the document as it was before this update,
 * so both `$cond`s see the old `expiresAt`. A missing `expiresAt` sorts below
 * any date, so `$lte` also covers the first hit.
 */
export function hitPipeline(timeWindow: number): Document[] {
  const closed = { $lte: ['$expiresAt', '$$NOW'] }
  return [
    {
      $set: {
        count: { $cond: [closed, 1, { $add: ['$count', 1] }] },
        expiresAt: { $cond: [closed, { $add: ['$$NOW', timeWindow] }, '$expiresAt'] },
      },
    },
  ]
}

/**
 * A `@fastify/rate-limit` store backed by the `rateLimits` collection.
 *
 * The default store keeps counters in process memory. That is wrong on
 * serverless: N warm instances give every route N independent counters, so a
 * 3/hour device-registration cap is really 3N/hour. One document per
 * route+caller gives the whole deployment a single counter.
 *
 * Old documents need no sweep: the `rateLimits_ttl` index drops them once
 * `expiresAt` passes.
 */
export function mongoRateLimitStore() {
  return class MongoRateLimitStore {
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
      // One atomic upsert, so two requests for the same key cannot both start
      // a fresh window.
      getStore()
        .rateLimits.findOneAndUpdate({ _id: this.prefix + key }, hitPipeline(timeWindow), {
          upsert: true,
        })
        .then(
          (doc) => {
            if (!doc) return cb(new Error('rateLimits upsert returned no document'))
            // App clock against the server's $$NOW; skew only shifts the
            // Retry-After hint, not the count.
            const ttl = Math.max(0, Math.ceil(doc.expiresAt.getTime() - Date.now()))
            cb(null, { current: doc.count, ttl })
          },
          (err: Error) => cb(err),
        )
    }

    // One counter per route, the way the package's own Redis store scopes keys.
    // Without this every rate-limited route would share a single document per
    // caller. `routeInfo` is optional here because the shipped types describe
    // the argument as a plain route options object and omit it; losing it
    // would merge every route onto one counter, which only tightens the limits.
    child(routeOptions: Partial<RouteOptions> & { routeInfo?: { method: string; url: string } }) {
      const route = routeOptions.routeInfo
      return new MongoRateLimitStore(undefined, route ? `${route.method}${route.url}-` : '')
    }
  }
}
