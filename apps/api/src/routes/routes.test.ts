import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import type { JwtPayload } from '../plugins/jwt.js'

process.env.JWT_SECRET ??= 'test-access-secret'
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret'

/**
 * Queue of rows the fake database hands back, consumed in order. Each route has
 * a fixed sequence of queries, so ordering is deterministic; `dbCalls` records
 * what was asked for so a test can assert on the write it triggered.
 */
const dbState = vi.hoisted(() => ({
  results: [] as unknown[][],
  calls: [] as { op: string; arg: unknown }[],
  failOn: null as string | null,
  failExecute: false,
}))

vi.mock('../plugins/db.js', async () => {
  const fastifyPlugin = (await import('fastify-plugin')).default

  // A proxy makes every builder method chainable without naming them, and makes
  // the builder awaitable. Awaiting it takes the next queued result, which is
  // how a `.where().groupBy().limit()` chain and a bare `.returning()` can share
  // one implementation.
  const chain = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => {
              const next = dbState.results.shift() ?? []
              return Promise.resolve(next).then(onOk, onErr)
            }
          }
          return (...args: unknown[]) => {
            dbState.calls.push({ op: String(prop), arg: args[0] })
            if (dbState.failOn === String(prop)) {
              throw Object.assign(new Error('duplicate key value'), { code: '23505' })
            }
            return chain()
          }
        },
      },
    )

  // Only the methods the routes actually call. A catch-all `get` is wrong here:
  // `fastify.decorate` probes the value for `getter` and `setter`, and a proxy
  // that answers every key with a function makes Fastify read the whole thing
  // as a getter/setter descriptor. `fastify.db` then resolves to whatever that
  // fake getter returned instead of this proxy, and `failExecute` never fires.
  const DB_METHODS = new Set(['select', 'insert', 'update', 'delete', 'execute', 'transaction'])

  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        const name = String(prop)
        if (!DB_METHODS.has(name)) return undefined
        if (name === 'execute' && dbState.failExecute) {
          return () => Promise.reject(new Error('connection to server at "db.example" failed'))
        }
        if (name === 'transaction') {
          // Real postgres rolls back when the callback rejects. Here the only
          // observable is that the rejection propagates out of `transaction`
          // rather than being swallowed inside the route.
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            dbState.calls.push({ op: 'transaction', arg: undefined })
            try {
              return await fn(db)
            } catch (err) {
              dbState.calls.push({ op: 'rollback', arg: undefined })
              throw err
            }
          }
        }
        return (...args: unknown[]) => {
          dbState.calls.push({ op: name, arg: args[0] })
          return chain()
        }
      },
    },
  )

  return {
    dbPlugin: fastifyPlugin(async (fastify: FastifyInstance) => {
      fastify.decorate('db', db as never)
    }),
  }
})

// Rate limiting is not what these tests cover. The plugin is a no-op here, so
// `config.rateLimit` on a route is simply inert metadata.
vi.mock('@fastify/rate-limit', () => ({ default: fp(async () => {}) }))

const { buildServer } = await import('../build-server.js')

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const USER_A = '33333333-3333-4333-8333-333333333333'
const DEVICE_A = '44444444-4444-4444-8444-444444444444'
const DATE = '2026-11-05'

const DASHBOARD_ROUTES = [
  '/v1/dashboard/overview',
  '/v1/dashboard/leaderboard',
  '/v1/dashboard/trends',
  '/v1/dashboard/activity',
  '/v1/dashboard/projects',
]

let app: FastifyInstance

// `/trends` takes `days` or `from`+`to` and does not accept `date`, which the
// other four do. A single-day range is the one query every dashboard route
// accepts, so the shared cases use it rather than special-casing trends.
const range = (url: string) => `${url}?from=${DATE}&to=${DATE}`

const token = (over: Partial<JwtPayload> = {}) =>
  app.jwt.access.sign({
    userId: USER_A,
    orgId: ORG_A,
    role: 'developer',
    ...over,
  } as JwtPayload)

const auth = (t: string) => ({ authorization: `Bearer ${t}` })

beforeEach(async () => {
  dbState.results = []
  dbState.calls = []
  dbState.failOn = null
  dbState.failExecute = false
  app = await buildServer()
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

describe('dashboard routes — authentication', () => {
  it.each(DASHBOARD_ROUTES)('%s returns 401 without a token', async (url) => {
    const res = await app.inject({ method: 'GET', url: range(url) })
    expect(res.statusCode).toBe(401)
  })

  it.each(DASHBOARD_ROUTES)('%s returns 401 for a garbage token', async (url) => {
    const res = await app.inject({
      method: 'GET',
      url: range(url),
      headers: auth('not.a.jwt'),
    })
    expect(res.statusCode).toBe(401)
  })

  it.each(DASHBOARD_ROUTES)('%s returns 401 for a token signed with the wrong secret', async (url) => {
    // A refresh token must not open a dashboard route.
    const wrong = app.jwt.refresh.sign({ userId: USER_A, orgId: ORG_A, role: 'admin' } as JwtPayload)
    const res = await app.inject({
      method: 'GET',
      url: range(url),
      headers: auth(wrong),
    })
    expect(res.statusCode).toBe(401)
  })

  it.each(DASHBOARD_ROUTES)('%s returns 403 for a device-role token', async (url) => {
    const res = await app.inject({
      method: 'GET',
      url: range(url),
      headers: auth(token({ role: 'device', deviceId: DEVICE_A })),
    })
    expect(res.statusCode).toBe(403)
  })

  it.each(['admin', 'manager', 'developer'] as const)('lets a %s role through', async (role) => {
    const res = await app.inject({
      method: 'GET',
      url: range('/v1/dashboard/overview'),
      headers: auth(token({ role })),
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('dashboard routes — org scoping', () => {
  // This is the IDOR fix. The dashboard client still sends `orgId` in the query
  // string, so a route reading it instead of the JWT would hand over another
  // org's spend to anyone who edits the URL.
  it.each(DASHBOARD_ROUTES)('%s ignores an orgId supplied in the query', async (url) => {
    const res = await app.inject({
      method: 'GET',
      url: `${range(url)}&orgId=${ORG_B}`,
      headers: auth(token({ orgId: ORG_A })),
    })

    expect(res.statusCode).toBe(200)
    // Asserted against the arguments the route actually handed the database.
    // This used to read the cache keys; those went with the cache, and the query
    // arguments are the better anchor regardless — they are what decides which
    // rows come back, where a cache key only described them afterwards.
    const queried = inspect(dbState.calls, { depth: null })
    expect(queried).toContain(ORG_A)
    expect(queried).not.toContain(ORG_B)
  })
})

describe('dashboard routes — query validation', () => {
  it.each(DASHBOARD_ROUTES)('%s rejects a date that is not YYYY-MM-DD', async (url) => {
    const res = await app.inject({
      method: 'GET',
      url: `${url}?from=20261105&to=20261105`,
      headers: auth(token()),
    })
    expect(res.statusCode).toBe(400)
  })

  it.each(DASHBOARD_ROUTES)('%s rejects a request with neither date nor from+to', async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: auth(token()) })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a leaderboard limit above the cap', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/leaderboard?date=${DATE}&limit=5000`,
      headers: auth(token()),
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /v1/usage', () => {
  const event = {
    agent: 'claude',
    date: DATE,
    modelName: 'claude-opus-5',
    inputTokens: 10,
    outputTokens: 5,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 15,
    costUsd: 0.5,
    isFreeTier: false,
  }
  const payload = { deviceId: DEVICE_A, date: DATE, events: [event], enrichment: null }

  const deviceToken = () => token({ role: 'device', deviceId: DEVICE_A })

  it('returns 401 without a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/usage', payload })
    expect(res.statusCode).toBe(401)
  })

  it('returns 403 when the payload deviceId does not match the token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage',
      headers: auth(deviceToken()),
      payload: { ...payload, deviceId: '55555555-5555-4555-8555-555555555555' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('Device ID mismatch')
  })

  it('returns 400 on a payload that fails schema validation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage',
      headers: auth(deviceToken()),
      payload: { ...payload, events: [{ ...event, date: '20261105' }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepts a submission and reports what was written', async () => {
    dbState.results.push([{ id: 'event-1' }]) // insert ... returning

    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage',
      headers: auth(deviceToken()),
      payload,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ accepted: 1, skipped: 0, date: DATE })
  })

  it('is idempotent: a replayed payload reports zero accepted, not an error', async () => {
    // The unique index on (userId, agent, date, modelName, deviceId) makes the
    // second insert a no-op, so `returning()` comes back empty.
    dbState.results.push([]) // insert ... returning, nothing inserted

    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage',
      headers: auth(deviceToken()),
      payload,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ accepted: 0, skipped: 1, date: DATE })
  })

  it('relies on onConflictDoNothing rather than a pre-read for deduplication', async () => {
    dbState.results.push([{ id: 'event-1' }])
    await app.inject({ method: 'POST', url: '/v1/usage', headers: auth(deviceToken()), payload })
    expect(dbState.calls.some((c) => c.op === 'onConflictDoNothing')).toBe(true)
  })

  it('runs every write inside one transaction', async () => {
    dbState.results.push([{ id: 'event-1' }])
    await app.inject({ method: 'POST', url: '/v1/usage', headers: auth(deviceToken()), payload })

    const ops = dbState.calls.map((c) => c.op)
    expect(ops[0]).toBe('transaction')
    // The event insert, the device touch and the snapshot rebuild all land
    // after the transaction opens, so none of them can commit on their own.
    expect(ops).toContain('insert')
    expect(ops).toContain('update')
    expect(ops).not.toContain('rollback')
  })

  it('rolls back and fails the request when the snapshot rebuild throws', async () => {
    // Previously this returned 200 with the events written and the snapshot
    // stale, and nothing retried it. Now the whole submission is undone, so the
    // agent's next run re-sends it.
    // The transaction's query sequence, in order: the event insert, the device
    // touch, then the rebuild's three selects. The user row has to be present
    // or the rebuild returns early and never reaches the write that fails.
    dbState.results.push([{ id: 'event-1' }]) // insert ... returning
    dbState.results.push([]) // update devices
    dbState.results.push([]) // rebuild: usage aggregated by agent
    dbState.results.push([]) // rebuild: enrichment
    dbState.results.push([{ orgId: ORG_A }]) // rebuild: user lookup
    dbState.failOn = 'onConflictDoUpdate' // rebuild: the snapshot upsert

    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage',
      headers: auth(deviceToken()),
      payload: { ...payload, enrichment: null },
    })

    expect(res.statusCode).toBe(500)
    expect(dbState.calls.map((c) => c.op)).toContain('rollback')
  })
})

describe('POST /v1/auth/admin/users', () => {
  const body = { email: 'new@example.com', name: 'New Dev' }

  it('returns 401 without a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/admin/users', payload: body })
    expect(res.statusCode).toBe(401)
  })

  it.each(['developer', 'manager', 'device'] as const)('returns 403 for a %s token', async (role) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin/users',
      headers: auth(token({ role })),
      payload: body,
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses to create a user in another organization', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin/users',
      headers: auth(token({ role: 'admin', orgId: ORG_A })),
      payload: { ...body, orgId: ORG_B },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('Cannot create users in another organization')
  })

  it('creates a user in the admin own organization', async () => {
    dbState.results.push([{ id: 'user-new' }])
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin/users',
      headers: auth(token({ role: 'admin' })),
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: 'user-new' })
    const insert = dbState.calls.find((c) => c.op === 'values')
    expect(insert?.arg).toMatchObject({ orgId: ORG_A, email: body.email })
  })

  it('returns 409 on a duplicate email rather than leaking the constraint error', async () => {
    dbState.failOn = 'returning'
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin/users',
      headers: auth(token({ role: 'admin' })),
      payload: body,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('A user with this email already exists')
    expect(res.payload).not.toContain('23505')
  })
})

describe('GET /v1/auth/admin/users', () => {
  const url = '/v1/auth/admin/users'

  const row = (over: Record<string, unknown> = {}) => ({
    id: USER_A,
    name: 'Dev One',
    email: 'dev1@example.com',
    role: 'developer',
    isActive: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    deviceCount: 1,
    hostnames: 'laptop-1',
    lastSeenAt: '2026-11-05T12:00:00.000Z',
    lastSyncDate: '2026-11-04',
    totalCostUsd: 12.5,
    totalTokens: 1000,
    activeDays: 3,
    ...over,
  })

  it('returns 401 without a token', async () => {
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(401)
  })

  it.each(['developer', 'manager', 'device'] as const)('returns 403 for a %s token', async (role) => {
    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role })) })
    expect(res.statusCode).toBe(403)
  })

  it('scopes the query to the caller own organization', async () => {
    dbState.results.push([row()])
    const res = await app.inject({
      method: 'GET',
      url,
      headers: auth(token({ role: 'admin', orgId: ORG_B })),
    })
    expect(res.statusCode).toBe(200)
    // The org filter is the only thing standing between one company's admin
    // and another company's roster, so assert it reached the query.
    expect(inspect(dbState.calls.find((c) => c.op === 'where')?.arg, { depth: 10 })).toContain(ORG_B)
  })

  it('includes a user who has never synced, with zeroed usage', async () => {
    dbState.results.push([
      row({ deviceCount: 0, hostnames: null, lastSeenAt: null, lastSyncDate: null, totalCostUsd: 0, totalTokens: 0, activeDays: 0 }),
    ])
    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
    expect(res.json()[0]).toMatchObject({
      deviceCount: 0,
      hostnames: [],
      lastSeenAt: null,
      lastSyncDate: null,
      totalCostUsd: 0,
    })
  })

  it('ranks by spend, highest first', async () => {
    dbState.results.push([
      row({ id: 'a', name: 'Low', totalCostUsd: 1 }),
      row({ id: 'b', name: 'High', totalCostUsd: 99 }),
    ])
    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })
    expect(res.json().map((u: { name: string }) => u.name)).toEqual(['High', 'Low'])
  })
})

describe('device registration', () => {
  it('does not issue tokens at registration, only a pending code', async () => {
    dbState.results.push([{ id: USER_A, orgId: ORG_A }]) // user lookup
    dbState.results.push([{ id: 'pending-1' }]) // pending insert

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register-device',
      payload: {
        email: 'dev@example.com',
        hostname: 'laptop.local',
        platform: 'darwin',
        agentVersion: '0.1.0',
      },
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json).toHaveProperty('pendingId')
    expect(json).toHaveProperty('code')
    expect(json).not.toHaveProperty('accessToken')
    expect(json).not.toHaveProperty('refreshToken')
  })

  it('returns 404 for an email that was never invited', async () => {
    dbState.results.push([]) // user lookup finds nothing
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register-device',
      payload: {
        email: 'stranger@example.com',
        hostname: 'laptop.local',
        platform: 'darwin',
        agentVersion: '0.1.0',
      },
    })
    expect(res.statusCode).toBe(404)
  })

  // BW-30. register-device hands the caller both halves of what verify-device
  // asks for, so before approval existed those two unauthenticated calls were a
  // complete path from "knows a colleague's work email" to a 30-day token.
  it('cannot be completed by the two unauthenticated calls alone', async () => {
    dbState.results.push([{ id: USER_A, orgId: ORG_A }]) // register: user lookup
    dbState.results.push([{ id: 'pending-1' }]) // register: pending insert

    const registered = await app.inject({
      method: 'POST',
      url: '/v1/auth/register-device',
      payload: {
        email: 'dev@example.com',
        hostname: 'laptop.local',
        platform: 'darwin',
        agentVersion: '0.1.0',
      },
    })
    const { pendingId, code } = registered.json()

    // Nothing approved the row, so the lookup matches nothing.
    dbState.results.push([])
    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-device',
      payload: { pendingId: '66666666-6666-4666-8666-666666666666', code },
    })

    expect(pendingId).toBe('pending-1')
    expect(verified.statusCode).toBe(400)
    expect(verified.json()).not.toHaveProperty('accessToken')

    // The fake database ignores predicates, so an empty result only proves the
    // route handles a miss. What makes the sequence fail is the predicate
    // itself: assert verify-device will not look at an unapproved row.
    const lookup = dbState.calls.filter((c) => c.op === 'where').at(-1)
    expect(inspect(lookup?.arg, { depth: null })).toMatch(/approved_at[\s\S]*is not null/)
  })

  it('rejects an unverifiable code without creating a device', async () => {
    dbState.results.push([]) // no matching unexpired, unverified pending row
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-device',
      payload: { pendingId: '66666666-6666-4666-8666-666666666666', code: 'ABC123' },
    })
    expect(res.statusCode).toBe(400)
    expect(dbState.calls.some((c) => c.op === 'insert')).toBe(false)
  })

  it('stores a hash of the access token, never the token itself', async () => {
    dbState.results.push([
      { id: 'pending-1', email: 'dev@example.com', hostname: 'laptop.local', platform: 'darwin', agentVersion: '0.1.0' },
    ])
    dbState.results.push([{ id: USER_A, orgId: ORG_A }])
    dbState.results.push([{ id: DEVICE_A }])

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-device',
      payload: { pendingId: '66666666-6666-4666-8666-666666666666', code: 'ABC123' },
    })

    expect(res.statusCode).toBe(200)
    const { accessToken } = res.json()
    const stored = dbState.calls
      .filter((c) => c.op === 'values')
      .map((c) => c.arg as Record<string, unknown>)
      .find((v) => 'tokenHash' in v)

    expect(stored?.tokenHash).toBeTypeOf('string')
    expect(stored?.tokenHash).not.toBe(accessToken)
    expect(String(stored?.tokenHash)).toHaveLength(64)
  })
})

describe('POST /v1/auth/approve-device', () => {
  const approve = (headers: Record<string, string> | undefined, code = 'ABC123') =>
    app.inject({ method: 'POST', url: '/v1/auth/approve-device', headers, payload: { code } })

  it('returns 401 without a token', async () => {
    const res = await approve(undefined)
    expect(res.statusCode).toBe(401)
  })

  it('returns 403 for a device-role token', async () => {
    // Otherwise an agent token would approve the next agent, and the browser
    // login this endpoint exists to require would be optional again.
    const res = await approve(auth(token({ role: 'device', deviceId: DEVICE_A })))
    expect(res.statusCode).toBe(403)
  })

  it('rejects a code that is not six characters', async () => {
    const res = await approve(auth(token()), 'ABC12')
    expect(res.statusCode).toBe(400)
  })

  it('approves only a row carrying the signed-in user own email', async () => {
    dbState.results.push([{ email: 'dev@example.com' }]) // user lookup by JWT userId
    dbState.results.push([{ hostname: 'laptop.local', platform: 'darwin' }]) // update ... returning

    const res = await approve(auth(token()))

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hostname: 'laptop.local', platform: 'darwin' })

    const claim = dbState.calls.filter((c) => c.op === 'where').at(-1)
    const predicate = inspect(claim?.arg, { depth: null })
    // The email comes from the database row for the token's userId, never from
    // the request, so a caller cannot approve someone else's pending device.
    expect(predicate).toContain('dev@example.com')
    expect(dbState.calls.find((c) => c.op === 'set')?.arg).toHaveProperty('approvedAt')
  })

  it('answers an unknown, expired or already-claimed code identically', async () => {
    dbState.results.push([{ email: 'dev@example.com' }])
    dbState.results.push([]) // the claiming update matched nothing

    const res = await approve(auth(token()))

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Invalid or expired verification code')
  })
})

describe('invites', () => {
  const adminToken = () => token({ role: 'admin' })

  describe('POST /v1/auth/admin/invites', () => {
    it('returns 401 without a token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/admin/invites',
        payload: { email: 'new@example.com' },
      })
      expect(res.statusCode).toBe(401)
    })

    it.each(['developer', 'manager', 'device'] as const)('returns 403 for a %s token', async (role) => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/admin/invites',
        headers: auth(token({ role })),
        payload: { email: 'new@example.com' },
      })
      expect(res.statusCode).toBe(403)
    })

    it('returns 409 when a user with that email already exists', async () => {
      dbState.results.push([{ id: USER_A }]) // user lookup hits
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/admin/invites',
        headers: auth(adminToken()),
        payload: { email: 'taken@example.com' },
      })
      expect(res.statusCode).toBe(409)
      // Nothing was written.
      expect(dbState.calls.some((c) => c.op === 'insert')).toBe(false)
    })

    it('stores only a hash, and scopes the invite to the admin own org', async () => {
      dbState.results.push([]) // no existing user
      dbState.results.push([{ id: 'invite-1' }]) // insert ... returning

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/admin/invites',
        headers: auth(adminToken()),
        payload: { email: 'New@Example.com ' },
      })

      expect(res.statusCode).toBe(200)
      const { token: plaintext } = res.json()
      const written = dbState.calls
        .filter((c) => c.op === 'values')
        .map((c) => c.arg as Record<string, unknown>)
        .find((v) => 'code' in v)!

      expect(written.code).toBe(createHash('sha256').update(plaintext).digest('hex'))
      expect(written.code).not.toBe(plaintext)
      expect(written.orgId).toBe(ORG_A)
      // Email is normalised, so an invite cannot be duplicated by casing.
      expect(written.email).toBe('new@example.com')
      expect(written.role).toBe('developer')
    })

    it('defaults the invite to a 7 day expiry in the future', async () => {
      dbState.results.push([])
      dbState.results.push([{ id: 'invite-1' }])
      const before = Date.now()

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/admin/invites',
        headers: auth(adminToken()),
        payload: { email: 'new@example.com' },
      })

      const expiresAt = new Date(res.json().expiresAt).getTime()
      expect(expiresAt).toBeGreaterThan(before)
      expect(expiresAt).toBeLessThanOrEqual(before + 7 * 24 * 60 * 60 * 1000 + 5000)
    })

    it('rejects a role outside the enum', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/admin/invites',
        headers: auth(adminToken()),
        payload: { email: 'new@example.com', role: 'owner' },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('GET /v1/auth/admin/invites', () => {
    it('returns 403 for a non-admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/admin/invites',
        headers: auth(token({ role: 'developer' })),
      })
      expect(res.statusCode).toBe(403)
    })

    it('never selects the stored hash', async () => {
      dbState.results.push([])
      await app.inject({
        method: 'GET',
        url: '/v1/auth/admin/invites',
        headers: auth(adminToken()),
      })
      const selected = dbState.calls.find((c) => c.op === 'select')?.arg as Record<string, unknown>
      expect(Object.keys(selected)).not.toContain('code')
    })
  })

  describe('POST /v1/auth/invites/accept', () => {
    const accept = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/auth/invites/accept', payload })

    it('needs no authentication', async () => {
      dbState.results.push([])
      const res = await accept({ token: 'whatever', name: 'New Dev' })
      expect(res.statusCode).not.toBe(401)
    })

    it('rejects an unknown, expired or already-used invite with one message', async () => {
      // The route filters on unused and unexpired in the query, so all three
      // failures arrive here as an empty result and must look identical.
      dbState.results.push([])
      const res = await accept({ token: 'nope', name: 'New Dev' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('Invalid or expired invite')
    })

    it('rejects a request with no name', async () => {
      const res = await accept({ token: 'abc' })
      expect(res.statusCode).toBe(400)
    })

    it('creates the user with the invite own org and role, not anything the caller sent', async () => {
      dbState.results.push([
        { id: 'invite-1', orgId: ORG_B, email: 'invited@example.com', role: 'manager' },
      ])
      dbState.results.push([{ id: 'invite-1' }]) // claim succeeded
      dbState.results.push([{ id: 'user-new' }]) // user insert

      const res = await accept({ token: 'good-token', name: '  New Dev  ' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        userId: 'user-new',
        orgId: ORG_B,
        email: 'invited@example.com',
        role: 'manager',
      })
      const written = dbState.calls
        .filter((c) => c.op === 'values')
        .map((c) => c.arg as Record<string, unknown>)
        .find((v) => 'email' in v)!
      expect(written.orgId).toBe(ORG_B)
      expect(written.role).toBe('manager')
      expect(written.name).toBe('New Dev')
    })

    it('marks the invite used before creating the user', async () => {
      dbState.results.push([{ id: 'invite-1', orgId: ORG_A, email: 'a@b.c', role: 'developer' }])
      dbState.results.push([{ id: 'invite-1' }])
      dbState.results.push([{ id: 'user-new' }])

      await accept({ token: 'good-token', name: 'New Dev' })

      const ops = dbState.calls.map((c) => c.op)
      // The lookup runs first, outside the transaction. The claim and the user
      // insert are both inside it, and the claim has to come first.
      expect(ops.indexOf('transaction')).toBeLessThan(ops.indexOf('update'))
      expect(ops.indexOf('update')).toBeLessThan(ops.indexOf('insert'))
    })

    it('cannot be replayed: the losing racer gets 400 and creates no user', async () => {
      // Both requests pass the select; the claiming UPDATE matches no row for
      // the second one because used_at is no longer null.
      dbState.results.push([{ id: 'invite-1', orgId: ORG_A, email: 'a@b.c', role: 'developer' }])
      dbState.results.push([]) // claim matched nothing

      const res = await accept({ token: 'good-token', name: 'New Dev' })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('Invalid or expired invite')
      expect(dbState.calls.some((c) => c.op === 'insert')).toBe(false)
    })
  })
})

describe('POST /v1/auth/refresh', () => {
  it('rejects an access token presented as a refresh token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: auth(token({ role: 'device', deviceId: DEVICE_A })),
    })
    expect(res.statusCode).toBe(401)
  })

  it('issues a new access token for a valid refresh token', async () => {
    const refresh = app.jwt.refresh.sign({
      userId: USER_A,
      orgId: ORG_A,
      deviceId: DEVICE_A,
      role: 'device',
    } as JwtPayload)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: auth(refresh),
    })

    expect(res.statusCode).toBe(200)
    const { accessToken } = res.json()
    expect(app.jwt.access.verify<JwtPayload>(accessToken)).toMatchObject({
      userId: USER_A,
      orgId: ORG_A,
      role: 'device',
    })
  })
})

describe('GET /health', () => {
  it('needs no authentication and returns 200 when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('returns 503 naming the database when the database is down', async () => {
    dbState.failExecute = true
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ok: false, failed: ['database'] })
  })

  it('leaks no connection details into the response body', async () => {
    // The driver error carries the host it failed to reach.
    dbState.failExecute = true
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.payload).not.toContain('db.example')
  })
})
