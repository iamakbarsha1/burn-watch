import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
import fp from 'fastify-plugin'
import { getTableName, is, Table } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { JwtPayload } from '../plugins/jwt.js'
import type { ProjectEntry } from '@burn-watch/shared'

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
const ALERT_A = '66666666-6666-4666-8666-666666666666'
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

// A device-role token is only good while its device_tokens row is unrevoked,
// so every device-authenticated request reads that row before the route's own
// queries. Queue the hit first or the route's results arrive one slot early.
const liveDeviceToken = () => dbState.results.push([{ id: 'token-1' }])

/**
 * A drizzle predicate rendered as the SQL it stands for, roughly
 * `device_id = <uuid> and revoked_at is null`.
 *
 * The older tests reach for `inspect` at full depth, which is fine for asking
 * whether a value reached the query. It cannot answer which columns a
 * predicate filters on: at that depth every chunk drags in its whole table
 * definition, so `expires_at` prints whether or not anything compares against
 * it. Walking the chunks is the difference between "the query mentions this
 * column" and "the query filters on it".
 */
function renderSql(node: unknown): string {
  if (node === null || typeof node !== 'object') return String(node)
  const n = node as Record<string, unknown>
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(renderSql).join('')
  if (Array.isArray(n.value)) return n.value.join('')
  if (typeof n.name === 'string') return n.name
  if ('value' in n) return String(n.value)
  return ''
}

const lastWhere = () => renderSql(dbState.calls.filter((c) => c.op === 'where').at(-1)?.arg)

/** Reads of `device_tokens`, counted by table identity rather than by matching
 * a string against an inspected object. Every device-authenticated request
 * pays for these, so the count is the guard's price on the hot path. */
const deviceTokenReads = () =>
  dbState.calls.filter(
    (c) => c.op === 'from' && is(c.arg, Table) && getTableName(c.arg) === 'device_tokens',
  )

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

// BW-25 wants the JSONB merge in these two routes moved from Node into SQL.
// These describe blocks characterize the merge as it exists today, including
// behaviour that is surprising, so the rewrite has to make a deliberate choice
// rather than drift. They assert on the mock's queued rows, which match the
// shape Drizzle's `select({...})` returns but not necessarily what the real
// driver coerces a JSONB column into — see the characterization note below on
// absent-vs-null columns.
describe('GET /v1/dashboard/activity — merge behaviour', () => {
  const activityUrl = () => range('/v1/dashboard/activity')
  const get = () => app.inject({ method: 'GET', url: activityUrl(), headers: auth(token()) })
  const enrichmentRow = (
    toolUsage: Record<string, number> | null | undefined = {},
    shellUsage: Record<string, number> | null | undefined = {},
    mcpUsage: Record<string, number> | null | undefined = {},
  ) => ({ toolUsage, shellUsage, mcpUsage })

  it('sums a key that two rows share', async () => {
    dbState.results.push([enrichmentRow({ bash: 5 }), enrichmentRow({ bash: 3 })])
    const res = await get()
    expect(res.json()).toContainEqual({ tool: 'bash', count: 8, category: 'tool' })
  })

  it('keeps a key that only one row has, with that row\'s own value', async () => {
    dbState.results.push([enrichmentRow({ bash: 5 }), enrichmentRow({ edit: 2 })])
    const res = await get()
    expect(res.json()).toEqual(
      expect.arrayContaining([
        { tool: 'bash', count: 5, category: 'tool' },
        { tool: 'edit', count: 2, category: 'tool' },
      ]),
    )
  })

  it('treats an absent or null JSONB field as contributing nothing, without throwing', async () => {
    // characterized, not endorsed: `?? {}` cannot tell "this column is null"
    // from "this column is an empty object". A SQL rewrite should pick one
    // meaning on purpose instead of collapsing both into it.
    dbState.results.push([{ toolUsage: null, shellUsage: undefined, mcpUsage: { neon: 4 } }])
    const res = await get()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([{ tool: 'neon', count: 4, category: 'mcp' }])
  })

  it('treats an empty object as contributing nothing', async () => {
    dbState.results.push([enrichmentRow({}, {}, { neon: 1 })])
    const res = await get()
    expect(res.json()).toEqual([{ tool: 'neon', count: 1, category: 'mcp' }])
  })

  it('keeps the same key name separate across categories', async () => {
    dbState.results.push([enrichmentRow({ git: 1 }, { git: 2 }, {})])
    const res = await get()
    expect(res.json()).toEqual(
      expect.arrayContaining([
        { tool: 'git', count: 1, category: 'tool' },
        { tool: 'git', count: 2, category: 'shell' },
      ]),
    )
    expect(res.json()).toHaveLength(2)
  })

  it('tags each entry with the category of its own source column', async () => {
    dbState.results.push([enrichmentRow({ bash: 1 }, { npx: 1 }, { playwright: 1 })])
    const res = await get()
    expect(res.json()).toEqual(
      expect.arrayContaining([
        { tool: 'bash', count: 1, category: 'tool' },
        { tool: 'npx', count: 1, category: 'shell' },
        { tool: 'playwright', count: 1, category: 'mcp' },
      ]),
    )
  })

  it('returns an empty array, not null, for zero matching rows', async () => {
    dbState.results.push([])
    const res = await get()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})

describe('GET /v1/dashboard/projects — merge behaviour', () => {
  const projectsUrl = () => range('/v1/dashboard/projects')
  const get = () => app.inject({ method: 'GET', url: projectsUrl(), headers: auth(token()) })
  const project = (over: Partial<ProjectEntry> = {}): ProjectEntry => ({
    path: 'acme/widgets',
    cost: 10,
    sessions: 4,
    avgPerSession: 2.5, // characterized: read off the merged entry, never used downstream
    overheadK: 0,
    ...over,
  })
  const enrichmentRow = (
    projects: ProjectEntry[] | null | undefined,
    userId = 'user-1',
  ) => ({ userId, projectBreakdown: projects })

  it('sums cost and sessions across rows sharing a path', async () => {
    dbState.results.push([
      enrichmentRow([project({ cost: 10, sessions: 4 })]),
      enrichmentRow([project({ cost: 5, sessions: 3 })]),
    ])
    const res = await get()
    expect(res.json()).toEqual([
      expect.objectContaining({ path: 'acme/widgets', totalCost: 15, totalSessions: 7 }),
    ])
  })

  it('derives avgCostPerSession as totalCost divided by totalSessions', async () => {
    dbState.results.push([enrichmentRow([project({ path: 'acme/uneven', cost: 10, sessions: 3 })])])
    const res = await get()
    expect(res.json()[0].avgCostPerSession).toBeCloseTo(10 / 3)
  })

  it('yields avgCostPerSession 0, not NaN or Infinity, when totalSessions is 0', async () => {
    dbState.results.push([enrichmentRow([project({ path: 'acme/free', cost: 7, sessions: 0 })])])
    const res = await get()
    expect(res.json()[0]).toMatchObject({ totalSessions: 0, avgCostPerSession: 0 })
  })

  it('treats a null or absent project_breakdown as contributing nothing', async () => {
    dbState.results.push([
      enrichmentRow(null),
      enrichmentRow(undefined),
      enrichmentRow([project({ path: 'acme/widgets' })]),
    ])
    const res = await get()
    expect(res.json()).toHaveLength(1)
    expect(res.json()[0].path).toBe('acme/widgets')
  })

  it('treats an empty array as contributing nothing', async () => {
    dbState.results.push([enrichmentRow([])])
    const res = await get()
    expect(res.json()).toEqual([])
  })

  it('counts one user once however many days they worked on the project', async () => {
    // There is one enrichment row per user per day, so a row count is a count
    // of user-days. The column is headed "Users" on the dashboard.
    dbState.results.push([
      enrichmentRow([project({ path: 'acme/widgets' })], 'user-1'), // 2026-11-04
      enrichmentRow([project({ path: 'acme/widgets' })], 'user-1'), // 2026-11-05
    ])
    const res = await get()
    expect(res.json()[0]).toMatchObject({ path: 'acme/widgets', userCount: 1 })
  })

  it('counts two different people on one project as two', async () => {
    dbState.results.push([
      enrichmentRow([project({ path: 'acme/widgets' })], 'user-1'),
      enrichmentRow([project({ path: 'acme/widgets' })], 'user-2'),
    ])
    const res = await get()
    expect(res.json()[0]).toMatchObject({ path: 'acme/widgets', userCount: 2 })
  })

  it('counts a user on each project they touch, not only the first', async () => {
    dbState.results.push([
      enrichmentRow(
        [project({ path: 'acme/widgets' }), project({ path: 'acme/gadgets' })],
        'user-1',
      ),
    ])
    const res = await get()
    expect(res.json()).toEqual([
      expect.objectContaining({ path: 'acme/widgets', userCount: 1 }),
      expect.objectContaining({ path: 'acme/gadgets', userCount: 1 }),
    ])
  })
})

const alertRow = (over: Record<string, unknown> = {}) => ({
  id: 'alert-1',
  userId: null,
  userName: null,
  agent: null,
  monthlyLimitUsd: '100',
  threshold: '0.8',
  createdAt: new Date('2026-01-01'),
  trippedAt: null,
  ...over,
})

describe('GET /v1/dashboard/budget-alerts', () => {
  const url = '/v1/dashboard/budget-alerts'
  const get = (headers?: Record<string, string>) => app.inject({ method: 'GET', url, headers })

  it('returns 401 without a token', async () => {
    const res = await get()
    expect(res.statusCode).toBe(401)
  })

  it('returns 403 for a device-role token', async () => {
    const res = await get(auth(token({ role: 'device', deviceId: DEVICE_A })))
    expect(res.statusCode).toBe(403)
  })

  it('returns an empty array when the org has no alerts', async () => {
    dbState.results.push([])
    const res = await get(auth(token()))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  // The IDOR fix every other dashboard route already applies: the query
  // string is not trusted for anything that decides whose data comes back.
  it('ignores an orgId supplied in the query', async () => {
    dbState.results.push([])
    const res = await app.inject({
      method: 'GET',
      url: `${url}?orgId=${ORG_B}`,
      headers: auth(token({ orgId: ORG_A })),
    })
    expect(res.statusCode).toBe(200)
    const queried = inspect(dbState.calls, { depth: null })
    expect(queried).toContain(ORG_A)
    expect(queried).not.toContain(ORG_B)
  })

  it('reports tripped true only when trippedAt falls in the current calendar month', async () => {
    const now = new Date()
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5)
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 5)

    dbState.results.push([
      alertRow({ id: 'alert-1', monthlyLimitUsd: '100', threshold: '0.8', trippedAt: thisMonth }),
      alertRow({ id: 'alert-2', monthlyLimitUsd: '50', threshold: '0.8', trippedAt: lastMonth }),
    ])
    dbState.results.push([{ spend: '90' }]) // alert-1 month-to-date spend
    dbState.results.push([{ spend: '10' }]) // alert-2 month-to-date spend

    const res = await get(auth(token()))
    const body = res.json() as Array<Record<string, unknown>>

    expect(body.find((a) => a.id === 'alert-1')).toMatchObject({
      tripped: true,
      monthToDateSpendUsd: 90,
    })
    expect(body.find((a) => a.id === 'alert-2')).toMatchObject({
      tripped: false,
      monthToDateSpendUsd: 10,
    })
  })
})

describe('POST /v1/dashboard/budget-alerts', () => {
  const url = '/v1/dashboard/budget-alerts'
  const post = (headers?: Record<string, string>, payload: Record<string, unknown> = { monthlyLimitUsd: 500 }) =>
    app.inject({ method: 'POST', url, headers, payload })

  it('returns 401 without a token', async () => {
    const res = await post(undefined)
    expect(res.statusCode).toBe(401)
  })

  it.each(['developer', 'manager', 'device'] as const)('returns 403 for a %s token', async (role) => {
    const res = await post(auth(token({ role, deviceId: DEVICE_A })))
    expect(res.statusCode).toBe(403)
  })

  it('rejects a payload that fails schema validation', async () => {
    const res = await post(auth(token({ role: 'admin' })), { monthlyLimitUsd: 500, threshold: 1.5 })
    expect(res.statusCode).toBe(400)
  })

  it('creates an org-wide alert when userId is omitted', async () => {
    dbState.results.push([{ id: 'new-alert-1' }]) // insert ... returning
    const res = await post(auth(token({ role: 'admin' })))
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ id: 'new-alert-1' })
    expect(dbState.calls.some((c) => c.op === 'select')).toBe(false)
  })

  it('refuses a userId belonging to another organization, and writes nothing', async () => {
    dbState.results.push([]) // user lookup matches nothing in this org
    const res = await post(auth(token({ role: 'admin' })), { monthlyLimitUsd: 500, userId: USER_A })
    expect(res.statusCode).toBe(400)
    expect(dbState.calls.some((c) => c.op === 'insert')).toBe(false)
  })

  it('creates a per-user alert once the user is confirmed in the caller org', async () => {
    dbState.results.push([{ id: USER_A }]) // user lookup
    dbState.results.push([{ id: 'new-alert-2' }]) // insert ... returning
    const res = await post(auth(token({ role: 'admin' })), { monthlyLimitUsd: 500, userId: USER_A })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ id: 'new-alert-2' })
  })
})

describe('PATCH /v1/dashboard/budget-alerts/:id', () => {
  const url = `/v1/dashboard/budget-alerts/${ALERT_A}`
  const patch = (headers?: Record<string, string>, payload: Record<string, unknown> = { monthlyLimitUsd: 250 }) =>
    app.inject({ method: 'PATCH', url, headers, payload })

  it('returns 401 without a token', async () => {
    const res = await patch(undefined)
    expect(res.statusCode).toBe(401)
  })

  it.each(['developer', 'manager', 'device'] as const)('returns 403 for a %s token', async (role) => {
    const res = await patch(auth(token({ role, deviceId: DEVICE_A })))
    expect(res.statusCode).toBe(403)
  })

  it('rejects an id that is not a uuid', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/dashboard/budget-alerts/not-a-uuid',
      headers: auth(token({ role: 'admin' })),
      payload: { monthlyLimitUsd: 250 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an empty patch body', async () => {
    const res = await patch(auth(token({ role: 'admin' })), {})
    expect(res.statusCode).toBe(400)
  })

  it('returns 404, and writes nothing, for an alert in another organization', async () => {
    dbState.results.push([]) // update ... returning, nothing matched
    const res = await patch(auth(token({ role: 'admin', orgId: ORG_B })))
    expect(res.statusCode).toBe(404)
    expect(lastWhere()).toContain(ORG_B)
  })

  it('updates the limit and returns the alert id', async () => {
    dbState.results.push([{ id: ALERT_A }]) // update ... returning
    const res = await patch(auth(token({ role: 'admin' })))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: ALERT_A })
  })
})

describe('DELETE /v1/dashboard/budget-alerts/:id', () => {
  const url = `/v1/dashboard/budget-alerts/${ALERT_A}`
  const del = (headers?: Record<string, string>) => app.inject({ method: 'DELETE', url, headers })

  it('returns 401 without a token', async () => {
    const res = await del(undefined)
    expect(res.statusCode).toBe(401)
  })

  it.each(['developer', 'manager', 'device'] as const)('returns 403 for a %s token', async (role) => {
    const res = await del(auth(token({ role, deviceId: DEVICE_A })))
    expect(res.statusCode).toBe(403)
  })

  it('returns 404, and deletes nothing, for an alert in another organization', async () => {
    dbState.results.push([]) // delete ... returning, nothing matched
    const res = await del(auth(token({ role: 'admin', orgId: ORG_B })))
    expect(res.statusCode).toBe(404)
    expect(lastWhere()).toContain(ORG_B)
  })

  it('deletes and returns the alert id', async () => {
    dbState.results.push([{ id: ALERT_A }]) // delete ... returning
    const res = await del(auth(token({ role: 'admin' })))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: ALERT_A })
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
    liveDeviceToken()
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
    liveDeviceToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage',
      headers: auth(deviceToken()),
      payload: { ...payload, events: [{ ...event, date: '20261105' }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('accepts a submission and reports what was written', async () => {
    liveDeviceToken()
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
    liveDeviceToken()
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
    liveDeviceToken()
    dbState.results.push([{ id: 'event-1' }])
    await app.inject({ method: 'POST', url: '/v1/usage', headers: auth(deviceToken()), payload })
    expect(dbState.calls.some((c) => c.op === 'onConflictDoNothing')).toBe(true)
  })

  it('runs every write inside one transaction', async () => {
    liveDeviceToken()
    dbState.results.push([{ id: 'event-1' }])
    await app.inject({ method: 'POST', url: '/v1/usage', headers: auth(deviceToken()), payload })

    const ops = dbState.calls.map((c) => c.op)
    // The event insert, the device touch and the snapshot rebuild all land
    // after the transaction opens, so none of them can commit on their own.
    expect(ops.indexOf('transaction')).toBeLessThan(ops.indexOf('insert'))
    expect(ops.indexOf('transaction')).toBeLessThan(ops.indexOf('update'))
    expect(ops).not.toContain('rollback')
  })

  it('rolls back and fails the request when the snapshot rebuild throws', async () => {
    // Previously this returned 200 with the events written and the snapshot
    // stale, and nothing retried it. Now the whole submission is undone, so the
    // agent's next run re-sends it.
    // The transaction's query sequence, in order: the event insert, the device
    // touch, then the rebuild's three selects. The user row has to be present
    // or the rebuild returns early and never reaches the write that fails.
    liveDeviceToken()
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

  it('evaluates budget alerts inside the same transaction, scoped to the caller org', async () => {
    liveDeviceToken()
    dbState.results.push([{ id: 'event-1' }]) // insert ... returning
    dbState.results.push([]) // update devices
    dbState.results.push([]) // rebuild: usage aggregated by agent
    dbState.results.push([]) // rebuild: enrichment
    dbState.results.push([{ orgId: ORG_A }]) // rebuild: user lookup
    dbState.results.push([]) // rebuild: snapshot upsert
    dbState.results.push([
      {
        id: 'alert-1',
        orgId: ORG_A,
        userId: null,
        agent: null,
        monthlyLimitUsd: '10',
        threshold: '1',
        trippedAt: null,
        createdAt: new Date('2026-01-01'),
      },
    ]) // evaluate: alerts for this org/user
    dbState.results.push([{ spend: '10' }]) // evaluate: month-to-date spend, exactly the trip point

    const res = await app.inject({
      method: 'POST',
      url: '/v1/usage',
      headers: auth(deviceToken()),
      payload: { ...payload, enrichment: null },
    })

    expect(res.statusCode).toBe(200)
    const ops = dbState.calls.map((c) => c.op)
    expect(ops).not.toContain('rollback')
    // The alert update lands after the rebuild's own upsert, inside the one
    // transaction the whole submission runs in.
    expect(ops.indexOf('transaction')).toBeLessThan(ops.lastIndexOf('update'))
    const tripWrite = dbState.calls.find((c) => c.op === 'set' && c.arg && 'trippedAt' in (c.arg as object))
    expect((tripWrite?.arg as { trippedAt: unknown })?.trippedAt).toBeInstanceOf(Date)
    // The alert lookup itself must be scoped to the caller's org, the same
    // posture every dashboard route takes.
    const whereClauses = dbState.calls.filter((c) => c.op === 'where').map((c) => renderSql(c.arg))
    expect(whereClauses.some((w) => w.includes(ORG_A))).toBe(true)
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
    // and another company's roster, so assert it reached the query. Looks
    // across every `where` rather than the first: the per-user subqueries each
    // add one of their own before the org filter is ever applied.
    const wheres = dbState.calls.filter((c) => c.op === 'where')
    expect(wheres.some((c) => inspect(c.arg, { depth: 10 }).includes(ORG_B))).toBe(true)
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

  it('keeps the calendar day when the driver parses a date into local midnight', async () => {
    // node-postgres builds this for a `date` column: midnight in the server's
    // own zone. Serialising it through toISOString in IST reports the 4th.
    dbState.results.push([row({ lastSyncDate: new Date(2026, 10, 5, 0, 0, 0) })])
    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })
    expect(res.json()[0].lastSyncDate).toBe('2026-11-05')
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
    liveDeviceToken()
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

describe('device token revocation', () => {
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

  const submit = () =>
    app.inject({
      method: 'POST',
      url: '/v1/usage',
      headers: auth(token({ role: 'device', deviceId: DEVICE_A })),
      payload,
    })

  const guardPredicate = () =>
    renderSql(dbState.calls.filter((c) => c.op === 'where').at(0)?.arg)

  it('refuses a device whose token row has been revoked', async () => {
    dbState.results.push([]) // no unrevoked row for this device

    const res = await submit()

    expect(res.statusCode).toBe(401)
    // The fake database ignores predicates, so an empty result only shows the
    // guard handles a miss. What makes a revoked laptop fail is the predicate
    // itself, so assert the lookup asks for a row that is still unrevoked.
    expect(guardPredicate()).toMatch(/revoked_at[\s\S]*is null/)
    expect(dbState.calls.some((c) => c.op === 'transaction')).toBe(false)
  })

  it('refuses a device that has no token row at all', async () => {
    dbState.results.push([])

    const res = await submit()

    expect(res.statusCode).toBe(401)
    // Scoped to the device the token names, so another laptop's live row
    // cannot authorise this one.
    expect(guardPredicate()).toContain(DEVICE_A)
  })

  it('lets a device with a live token row through', async () => {
    liveDeviceToken()
    dbState.results.push([{ id: 'event-1' }])

    const res = await submit()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ accepted: 1, skipped: 0, date: DATE })
    // Without this the test passes on a build that never looks the device up,
    // because the queued row is simply consumed by the event insert instead.
    // One read, not two: this is the whole cost the guard adds to every
    // usage submission, and it should stay one statement.
    expect(deviceTokenReads()).toHaveLength(1)
  })

  it('still authorises a device whose row is past expires_at but not revoked', async () => {
    // Looks wrong until you follow the refresh path. `expires_at` is written
    // once at registration as now + 30 days and never updated, while
    // /v1/auth/refresh mints a fresh 30-day access token without inserting a
    // new row. An `expires_at > now()` term here would 401 every legitimately
    // refreshing device on day 31. Expiry is the JWT `exp` claim's job, and
    // accessJwtVerify has already checked it by the time this runs.
    liveDeviceToken()
    dbState.results.push([{ id: 'event-1' }])

    const res = await submit()

    expect(res.statusCode).toBe(200)
    expect(deviceTokenReads()).toHaveLength(1)
    expect(guardPredicate()).not.toContain('expires_at')
  })

  it('never reads device_tokens for a dashboard role, which has no row', async () => {
    // Nothing is queued, so an unconditional lookup would read an empty result
    // and 401 every dashboard request. Dashboard users come through the same
    // accessJwtVerify and have no device_tokens row at all.
    const res = await app.inject({
      method: 'GET',
      url: range('/v1/dashboard/overview'),
      headers: auth(token({ role: 'developer' })),
    })

    expect(res.statusCode).toBe(200)
    expect(deviceTokenReads()).toHaveLength(0)
  })

  it('refuses to refresh a revoked device', async () => {
    // Without this the ticket undoes itself: a revoked laptop trades its
    // refresh token for another 30 days of access.
    dbState.results.push([]) // no unrevoked row
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

    expect(res.statusCode).toBe(401)
    expect(res.json()).not.toHaveProperty('accessToken')
  })
})

describe('POST /v1/auth/admin/devices/revoke', () => {
  const url = '/v1/auth/admin/devices/revoke'
  const body = { deviceId: DEVICE_A }

  const revoke = (headers?: Record<string, string>, payload: Record<string, string> = body) =>
    app.inject({ method: 'POST', url, headers, payload })

  it('returns 401 without a token', async () => {
    const res = await revoke(undefined)
    expect(res.statusCode).toBe(401)
  })

  it.each(['developer', 'manager', 'device'] as const)('returns 403 for a %s token', async (role) => {
    const res = await revoke(auth(token({ role, deviceId: DEVICE_A })))
    expect(res.statusCode).toBe(403)
  })

  it('rejects a deviceId that is not a uuid', async () => {
    const res = await revoke(auth(token({ role: 'admin' })), { deviceId: 'not-a-uuid' })
    expect(res.statusCode).toBe(400)
  })

  it('revokes every live row for the device', async () => {
    dbState.results.push([{ id: DEVICE_A }]) // device sits under a user in the caller's org
    dbState.results.push([{ id: 'token-1' }, { id: 'token-2' }]) // update ... returning

    const res = await revoke(auth(token({ role: 'admin' })))

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ deviceId: DEVICE_A, revoked: 2 })
    expect(dbState.calls.find((c) => c.op === 'set')?.arg).toHaveProperty('revokedAt')
    // No limit, and scoped to rows that are still live, so one call ends every
    // token the laptop holds and a second call is a no-op rather than a lie
    // about how many it just ended.
    const claim = lastWhere()
    expect(claim).toContain(DEVICE_A)
    expect(claim).toMatch(/revoked_at[\s\S]*is null/)
    expect(dbState.calls.some((c) => c.op === 'limit')).toBe(false)
  })

  it('reports zero rather than failing when the device holds no live token', async () => {
    dbState.results.push([{ id: DEVICE_A }])
    dbState.results.push([]) // nothing left to revoke

    const res = await revoke(auth(token({ role: 'admin' })))

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ deviceId: DEVICE_A, revoked: 0 })
  })

  it('refuses a device in another organization and writes nothing', async () => {
    dbState.results.push([]) // the org-scoped lookup matches nothing

    const res = await revoke(auth(token({ role: 'admin', orgId: ORG_B })))

    expect(res.statusCode).toBe(404)
    expect(dbState.calls.some((c) => c.op === 'update')).toBe(false)
    // The lookup is the whole control: the device has to hang off a user in
    // the caller's own org before anything is written.
    expect(lastWhere()).toContain(ORG_B)
  })
})

describe('POST /v1/auth/revoke-device', () => {
  const url = '/v1/auth/revoke-device'

  it('returns 401 without a token', async () => {
    const res = await app.inject({ method: 'POST', url })
    expect(res.statusCode).toBe(401)
  })

  it.each(['admin', 'manager', 'developer'] as const)('returns 403 for a %s token', async (role) => {
    const res = await app.inject({ method: 'POST', url, headers: auth(token({ role })) })
    expect(res.statusCode).toBe(403)
  })

  it('revokes the caller own device and nothing else', async () => {
    // `burnwatch uninstall` is the only caller. The admin endpoint cannot
    // serve it: a device token is not an admin token.
    liveDeviceToken() // requireAuth's own guard
    dbState.results.push([{ id: 'token-1' }]) // update ... returning

    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth(token({ role: 'device', deviceId: DEVICE_A })),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ deviceId: DEVICE_A, revoked: 1 })
    expect(lastWhere()).toContain(DEVICE_A)
  })
})

describe('GET /v1/auth/admin/devices', () => {
  const url = '/v1/auth/admin/devices'

  it.each(['developer', 'manager', 'device'] as const)('returns 403 for a %s token', async (role) => {
    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role })) })
    expect(res.statusCode).toBe(403)
  })

  it('lists only devices in the caller own organization', async () => {
    dbState.results.push([
      {
        id: DEVICE_A,
        hostname: 'laptop-1',
        platform: 'darwin',
        lastSeenAt: '2026-11-05T12:00:00.000Z',
        userName: 'Dev One',
        userEmail: 'dev1@example.com',
        liveTokens: 1,
      },
    ])

    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin', orgId: ORG_B })) })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      {
        id: DEVICE_A,
        hostname: 'laptop-1',
        platform: 'darwin',
        lastSeenAt: '2026-11-05T12:00:00.000Z',
        userName: 'Dev One',
        userEmail: 'dev1@example.com',
        revoked: false,
      },
    ])
    const wheres = dbState.calls.filter((c) => c.op === 'where')
    expect(wheres.some((c) => inspect(c.arg, { depth: 10 }).includes(ORG_B))).toBe(true)
  })

  it('takes the org from the token and ignores one supplied in the query', async () => {
    // A read that leaks the fleet is a smaller hole than a write, not a
    // non-hole: this route hands back every hostname and owner email in an
    // org, so the filter has to come from the JWT and nowhere else.
    dbState.results.push([])

    const res = await app.inject({
      method: 'GET',
      url: `${url}?orgId=${ORG_B}`,
      headers: auth(token({ role: 'admin', orgId: ORG_A })),
    })

    expect(res.statusCode).toBe(200)
    const queried = inspect(dbState.calls, { depth: null })
    expect(queried).toContain(ORG_A)
    expect(queried).not.toContain(ORG_B)
  })

  it('marks a device with no live token as revoked', async () => {
    dbState.results.push([
      {
        id: DEVICE_A,
        hostname: 'laptop-1',
        platform: 'darwin',
        lastSeenAt: null,
        userName: 'Dev One',
        userEmail: 'dev1@example.com',
        liveTokens: 0,
      },
    ])

    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })

    expect(res.json()[0]).toMatchObject({ revoked: true, lastSeenAt: null })
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
