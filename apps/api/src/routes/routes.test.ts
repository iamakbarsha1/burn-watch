import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
import fp from 'fastify-plugin'
import { getTableName, is, Table } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { JwtPayload } from '../plugins/jwt.js'
import { EXPECTED_SCHEMA_VERSION } from '../schema-version.js'

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
  // `$with` and `with` are here because the activity and projects aggregates
  // open with a CTE. The chain swallows them like any other builder call.
  const DB_METHODS = new Set([
    'select',
    'insert',
    'update',
    'delete',
    'execute',
    'transaction',
    '$with',
    'with',
  ])

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

/**
 * The MongoDB side: documents a test seeds per collection, and the two health
 * checks, controllable per test.
 *
 * `getStore` and `runInTxn` are replaced; everything else in the package is the
 * real thing, so the usage upsert, the snapshot rebuild and the month-to-date
 * aggregation under these routes are the code that ships rather than a second
 * implementation written to agree with the assertions.
 *
 * The health checks are replaced because the real ones resolve a client from
 * MONGODB_URI, which is unset here. Both would then reject in every test that
 * touches `/health`, turning the healthy case into a 503 and padding `failed`
 * on the postgres cases, which is exactly the kind of coupling that makes a
 * health assertion stop meaning anything.
 */
const mongoState = vi.hoisted(() => ({
  pingFails: false,
  schemaFails: false,
  docs: {} as Record<string, Record<string, unknown>[]>,
  aggregates: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as { op: string; collection: string; args: unknown[] }[],
  failOn: null as string | null,
  bulk: { upsertedCount: 1, matchedCount: 0 },
}))

vi.mock('@burn-watch/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@burn-watch/db')>()
  const { fakeStore, fakeRunInTxn } = await import('../mongo-store.fake.js')
  const store = fakeStore(mongoState, Object.keys(real.COLLECTIONS))

  return {
    ...real,
    getStore: () => store,
    runInTxn: fakeRunInTxn(mongoState, store),
    // Both model the one thing the real pair does before anything else: they
    // default to `getDb()`, which resolves a client from MONGODB_URI and
    // throws when it is unset. Leaving that out would make the fakes healthier
    // than the code they stand in for, and `/health` is the one route whose
    // whole value is not being healthier than what it reports on.
    pingDb: async () => {
      if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set')
      if (mongoState.pingFails) throw new Error('connect ECONNREFUSED mongo.example:27017')
    },
    assertSchemaCurrent: async () => {
      if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set')
      if (mongoState.schemaFails) {
        throw new Error('MongoDB schema drift.\n  missing indexes: usageEvents.usageEvents_key')
      }
    },
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
  mongoState.pingFails = false
  mongoState.schemaFails = false
  mongoState.docs = {}
  mongoState.aggregates = {}
  mongoState.calls = []
  mongoState.failOn = null
  mongoState.bulk = { upsertedCount: 1, matchedCount: 0 }
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
    // Asserted against the arguments the route actually handed the store. The
    // fake answers a read from what the test seeded for that collection and
    // ignores the filter entirely, so seeding a second org's documents and
    // watching them not come back would prove nothing — the pipeline is the
    // only place the scoping exists, and this reads it rather than
    // re-implementing it. The cross-org read is executed for real against a
    // server in `src/scripts/dashboard-pipelines.ts`.
    const queried = inspect(mongoState.calls, { depth: null })
    expect(queried).toContain(ORG_A)
    expect(queried).not.toContain(ORG_B)
  })

  it.each(DASHBOARD_ROUTES)('%s reads nothing from postgres', async (url) => {
    // The point of the phase. A route left half-ported reads its totals from
    // one store and its names from the other, and the two disagree silently
    // from the Phase 7 backfill onwards.
    await app.inject({
      method: 'GET',
      url: range(url),
      headers: auth(token()),
    })
    expect(dbState.calls).toEqual([])
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

/**
 * The merge these routes used to do in node now happens in the database, so
 * what is left in a handler is the mapping of an aggregate's rows onto the
 * response shape — and every one of these reads that mapping.
 *
 * Three things they deliberately cannot show, because the fake answers a read
 * from what the test seeded and never looks at the pipeline:
 *
 *   - that the grouping sums the right field, or groups on the right key;
 *   - that the `$match` keeps another org's documents out;
 *   - that `$addToSet` plus `$size` counts people rather than user-days.
 *
 * `enrichment-query.test.ts` and `overview-query.test.ts` read the stages, and
 * `src/scripts/dashboard-pipelines.ts` runs all five against a real server with
 * two orgs seeded. Seeding a second org into the fake would look like a
 * cross-org test and assert nothing.
 */
const dashboardAggregate = (collection: string, rows: Record<string, unknown>[]) => {
  mongoState.aggregates[collection] = rows
}

describe('GET /v1/dashboard/overview', () => {
  const get = (url = range('/v1/dashboard/overview')) =>
    app.inject({ method: 'GET', url, headers: auth(token()) })

  const facet = (over: Record<string, unknown> = {}) =>
    dashboardAggregate('dailySnapshots', [
      { totals: [{ costMicros: 12 * USD, tokens: 400, activeUsers: 3 }], byAgent: [], ...over },
    ])

  it('renders the stored micros as dollars', async () => {
    facet()
    expect((await get()).json()).toMatchObject({ totalCostUsd: 12, totalTokens: 400 })
  })

  it('reports the distinct-developer count the pipeline computed', async () => {
    facet()
    expect((await get()).json().activeUsers).toBe(3)
  })

  it('answers zeros, not nulls, when the org has no snapshots in range', async () => {
    dashboardAggregate('dailySnapshots', [])
    expect((await get()).json()).toMatchObject({
      totalCostUsd: 0,
      totalTokens: 0,
      activeUsers: 0,
      vsYesterday: { costDelta: 0, costPct: 0, tokensDelta: 0 },
    })
  })

  it('lists every agent in a fixed order, zero-filling the ones with no row', async () => {
    facet({ byAgent: [{ _id: 'copilot', tokens: 90, costMicros: 3 * USD }] })
    expect((await get()).json().byAgent).toEqual([
      { agent: 'claude', tokens: 0, costUsd: 0, isFreeTier: true },
      { agent: 'qwen', tokens: 0, costUsd: 0, isFreeTier: true },
      { agent: 'gemini', tokens: 0, costUsd: 0, isFreeTier: true },
      { agent: 'codex', tokens: 0, costUsd: 0, isFreeTier: true },
      { agent: 'copilot', tokens: 90, costUsd: 3, isFreeTier: false },
    ])
  })

  it('drops an agent name the shared union does not carry', async () => {
    // A document written by a later build must not add a column to the page.
    facet({ byAgent: [{ _id: 'mystery', tokens: 5, costMicros: USD }] })
    expect((await get()).json().byAgent.map((a: { agent: string }) => a.agent)).toEqual([
      'claude',
      'qwen',
      'gemini',
      'codex',
      'copilot',
    ])
  })

  it('marks an agent that reported tokens at no cost as free tier', async () => {
    facet({ byAgent: [{ _id: 'qwen', tokens: 280_000_000, costMicros: 0 }] })
    const qwen = (await get()).json().byAgent.find((a: { agent: string }) => a.agent === 'qwen')
    expect(qwen).toEqual({ agent: 'qwen', tokens: 280_000_000, costUsd: 0, isFreeTier: true })
  })

  it('derives the delta against the previous day the pipeline returned', async () => {
    const url = `/v1/dashboard/overview?date=${DATE}`
    facet({ previous: [{ costMicros: 10 * USD, tokens: 100, activeUsers: 1 }] })
    expect((await get(url)).json().vsYesterday).toEqual({
      costDelta: 2,
      costPct: 20,
      tokensDelta: 300,
    })
  })

  it('reports 0 percent, not Infinity, when the previous day spent nothing', async () => {
    const url = `/v1/dashboard/overview?date=${DATE}`
    facet({ previous: [{ costMicros: 0, tokens: 0, activeUsers: 0 }] })
    expect((await get(url)).json().vsYesterday).toMatchObject({ costDelta: 12, costPct: 0 })
  })

  it('asks for no previous day on a multi-day range, and reports a zero delta', async () => {
    facet()
    const res = await get(`/v1/dashboard/overview?from=2026-11-01&to=${DATE}`)
    expect(res.json().vsYesterday).toEqual({ costDelta: 0, costPct: 0, tokensDelta: 0 })
    expect(res.json().date).toBe(`2026-11-01 — ${DATE}`)
    const [pipeline] = mongoCalls('dailySnapshots', 'aggregate')[0] as [Record<string, never>[]]
    expect(JSON.stringify(pipeline)).not.toContain('previous')
  })

  it('labels a single-day view with the bare date', async () => {
    facet()
    expect((await get(`/v1/dashboard/overview?date=${DATE}`)).json().date).toBe(DATE)
  })
})

describe('GET /v1/dashboard/leaderboard', () => {
  const url = range('/v1/dashboard/leaderboard')
  const get = () => app.inject({ method: 'GET', url, headers: auth(token()) })

  const seed = (over: Record<string, unknown> = {}) => {
    dashboardAggregate('dailySnapshots', [
      {
        users: [{ _id: USER_A, totalCostMicros: 20 * USD, totalTokens: 900, sessions: 7 }],
        agents: [],
        everyone: [{ ids: [USER_A] }],
        ...over,
      },
    ])
    mongoState.docs.users = [{ _id: USER_A, name: 'Ada', email: 'ada@example.com' }]
  }

  it('renders a person with their totals in dollars', async () => {
    seed()
    expect((await get()).json()).toEqual([
      expect.objectContaining({
        userId: USER_A,
        name: 'Ada',
        email: 'ada@example.com',
        totalCostUsd: 20,
        totalTokens: 900,
        sessions: 7,
        cacheHitRate: null,
      }),
    ])
  })

  it('maps each agent onto its own field, zero-filling the ones with no row', async () => {
    seed({
      agents: [
        { _id: { userId: USER_A, agent: 'claude' }, tokens: 800, costMicros: 19 * USD },
        { _id: { userId: USER_A, agent: 'codex' }, tokens: 100, costMicros: USD },
      ],
    })
    expect((await get()).json()[0]).toMatchObject({
      claude: { tokens: 800, costUsd: 19 },
      codex: { tokens: 100, costUsd: 1 },
      qwen: { tokens: 0, costUsd: 0 },
      gemini: { tokens: 0, costUsd: 0 },
      copilot: { tokens: 0, costUsd: 0 },
    })
  })

  it('never credits one person with another person agent totals', async () => {
    seed({
      agents: [
        { _id: { userId: 'someone-else', agent: 'claude' }, tokens: 999, costMicros: 99 * USD },
      ],
    })
    expect((await get()).json()[0].claude).toEqual({ tokens: 0, costUsd: 0 })
  })

  it('returns an empty array, and reads no users, when nobody spent anything', async () => {
    dashboardAggregate('dailySnapshots', [])
    const res = await get()
    expect(res.json()).toEqual([])
    expect(mongoCalls('users', 'find')).toEqual([])
  })

  it('fails loudly when a snapshot has no user document, naming the id it could not resolve', async () => {
    // Postgres declared `daily_snapshots.user_id` NOT NULL with a cascading
    // foreign key, so the inner join never dropped a row. MongoDB enforces
    // nothing of the kind, and a leaderboard quietly missing people reads
    // exactly like an org where nobody spent anything.
    //
    // Asserted on the thrown error, not on the 500 alone. Deleting the guard
    // also produces a 500 — a TypeError off the undefined user, a line later —
    // so a test that stopped at the status code would pass with the guard gone
    // and keep passing the day someone "fixes" that crash with a `?? null`,
    // which is the blank-name row the guard exists to refuse.
    seed()
    mongoState.docs.users = []
    const logged = vi.spyOn(app.log, 'error')
    const res = await get()
    expect(res.statusCode).toBe(500)
    const thrown = logged.mock.calls.at(-1)?.[0] as Error
    expect(thrown?.message).toContain('no user document')
    expect(thrown?.message).toContain(USER_A)
  })

  it('refuses the request for an unresolvable person who is not even on this page', async () => {
    // The check runs over everyone in range, not the page, so the failure does
    // not move depending on which page was asked for. Looking it up per page
    // made an orphan that sorted onto page 0 fail page 0 and leave page 1
    // answering 200 — an integrity failure you could page past.
    seed({ everyone: [{ ids: [USER_A, '99999999-9999-4999-8999-999999999999'] }] })
    const logged = vi.spyOn(app.log, 'error')
    const res = await get()
    expect(res.statusCode).toBe(500)
    expect((logged.mock.calls.at(-1)?.[0] as Error)?.message).toContain('99999999')
  })

  it('scopes the user lookup to the caller org', async () => {
    seed()
    await get()
    expect(mongoCalls('users', 'find')[0][0]).toMatchObject({ orgId: ORG_A })
  })

  it('looks up everyone in range, not just the page it is about to render', async () => {
    seed({ everyone: [{ ids: [USER_A, 'someone-on-page-two'] }] })
    mongoState.docs.users = [
      { _id: USER_A, name: 'Ada', email: 'ada@example.com' },
      { _id: 'someone-on-page-two', name: 'Bo', email: 'bo@example.com' },
    ]
    await get()
    expect(mongoCalls('users', 'find')[0][0]).toMatchObject({
      _id: { $in: [USER_A, 'someone-on-page-two'] },
    })
  })

  it('passes the paging window to the database, not to node', async () => {
    seed()
    await app.inject({
      method: 'GET',
      url: `/v1/dashboard/leaderboard?date=${DATE}&limit=5&offset=10`,
      headers: auth(token()),
    })
    const [pipeline] = mongoCalls('dailySnapshots', 'aggregate')[0] as [Record<string, never>[]]
    const rendered = JSON.stringify(pipeline)
    expect(rendered).toContain('"$limit":5')
    expect(rendered).toContain('"$skip":10')
  })
})

describe('GET /v1/dashboard/trends', () => {
  const url = range('/v1/dashboard/trends')
  const get = () => app.inject({ method: 'GET', url, headers: auth(token()) })

  const seed = (over: Record<string, unknown> = {}) =>
    dashboardAggregate('dailySnapshots', [
      {
        days: [{ _id: DATE, totalCostMicros: 9 * USD, totalTokens: 500 }],
        agents: [],
        ...over,
      },
    ])

  it('renders one point per day, in dollars', async () => {
    seed()
    expect((await get()).json()).toEqual([
      expect.objectContaining({ date: DATE, totalCost: 9, totalTokens: 500 }),
    ])
  })

  it('keeps the order the pipeline sorted the days into', async () => {
    seed({
      days: [
        { _id: '2026-11-04', totalCostMicros: USD, totalTokens: 1 },
        { _id: DATE, totalCostMicros: 2 * USD, totalTokens: 2 },
      ],
    })
    expect((await get()).json().map((p: { date: string }) => p.date)).toEqual(['2026-11-04', DATE])
  })

  it('maps each agent cost onto its own series, zero-filling the silent ones', async () => {
    seed({
      agents: [
        { _id: { date: DATE, agent: 'claude' }, tokens: 400, costMicros: 8 * USD },
        { _id: { date: DATE, agent: 'gemini' }, tokens: 100, costMicros: USD },
      ],
    })
    expect((await get()).json()[0]).toMatchObject({
      claudeCost: 8,
      claudeTokens: 400,
      geminiCost: 1,
      qwenCost: 0,
      qwenTokens: 0,
      codexCost: 0,
      copilotCost: 0,
    })
  })

  it('never credits one day with another day agent totals', async () => {
    seed({ agents: [{ _id: { date: '2026-01-01', agent: 'claude' }, tokens: 9, costMicros: USD }] })
    expect((await get()).json()[0]).toMatchObject({ claudeCost: 0, claudeTokens: 0 })
  })

  it('returns an empty array, not null, for a range with no snapshots', async () => {
    dashboardAggregate('dailySnapshots', [])
    expect((await get()).json()).toEqual([])
  })
})

describe('GET /v1/dashboard/activity', () => {
  const get = () =>
    app.inject({ method: 'GET', url: range('/v1/dashboard/activity'), headers: auth(token()) })

  it('hands back the rows the aggregate produced, unchanged', async () => {
    // The pipeline already emits `ToolUsageSummary`. There is nothing left for
    // the handler to fold, which is the whole point of the move.
    dashboardAggregate('claudeEnrichment', [
      { tool: 'bash', count: 8, category: 'tool' },
      { tool: 'git', count: 2, category: 'shell' },
      { tool: 'playwright', count: 1, category: 'mcp' },
    ])
    expect((await get()).json()).toEqual([
      { tool: 'bash', count: 8, category: 'tool' },
      { tool: 'git', count: 2, category: 'shell' },
      { tool: 'playwright', count: 1, category: 'mcp' },
    ])
  })

  it('does not re-sum in node what the database already grouped', async () => {
    // Two rows carrying one tool name would mean the `$group` key is wrong;
    // folding them here would hide that behind a plausible-looking total.
    dashboardAggregate('claudeEnrichment', [
      { tool: 'bash', count: 5, category: 'tool' },
      { tool: 'bash', count: 3, category: 'tool' },
    ])
    expect((await get()).json()).toHaveLength(2)
  })

  it('reads the enrichment collection, not the snapshots', async () => {
    await get()
    expect(mongoCalls('claudeEnrichment', 'aggregate')).toHaveLength(1)
    expect(mongoCalls('dailySnapshots', 'aggregate')).toEqual([])
  })

  it('returns an empty array, not null, for zero matching documents', async () => {
    dashboardAggregate('claudeEnrichment', [])
    const res = await get()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})

describe('GET /v1/dashboard/projects', () => {
  const get = () =>
    app.inject({ method: 'GET', url: range('/v1/dashboard/projects'), headers: auth(token()) })

  const totals = (over: Record<string, unknown> = {}) =>
    dashboardAggregate('claudeEnrichment', [
      { path: 'acme/widgets', totalCost: 15, totalSessions: 6, userCount: 2, ...over },
    ])

  it('passes the folded figures through and adds the derived average', async () => {
    totals()
    expect((await get()).json()).toEqual([
      {
        path: 'acme/widgets',
        totalCost: 15,
        totalSessions: 6,
        userCount: 2,
        avgCostPerSession: 2.5,
      },
    ])
  })

  it('derives avgCostPerSession as totalCost divided by totalSessions', async () => {
    totals({ path: 'acme/uneven', totalCost: 10, totalSessions: 3 })
    expect((await get()).json()[0].avgCostPerSession).toBeCloseTo(10 / 3)
  })

  it('yields avgCostPerSession 0, not NaN or Infinity, when totalSessions is 0', async () => {
    // The guard is why this one field stayed in node: `$divide` by zero errors
    // the whole stage, taking every other project down with it.
    totals({ path: 'acme/free', totalCost: 7, totalSessions: 0 })
    expect((await get()).json()[0]).toMatchObject({ totalSessions: 0, avgCostPerSession: 0 })
  })

  it('does not re-fold in node what the database already grouped', async () => {
    // Two rows on one path would mean the `$group` key is wrong; folding them
    // here would hide that behind a plausible-looking total.
    dashboardAggregate('claudeEnrichment', [
      { path: 'acme/widgets', totalCost: 10, totalSessions: 4, userCount: 1 },
      { path: 'acme/widgets', totalCost: 5, totalSessions: 2, userCount: 1 },
    ])
    expect((await get()).json()).toHaveLength(2)
  })

  it('reads the enrichment collection, not the snapshots', async () => {
    await get()
    expect(mongoCalls('claudeEnrichment', 'aggregate')).toHaveLength(1)
    expect(mongoCalls('dailySnapshots', 'aggregate')).toEqual([])
  })

  it('returns an empty array, not null, for zero matching documents', async () => {
    dashboardAggregate('claudeEnrichment', [])
    expect((await get()).json()).toEqual([])
  })
})
/** Whole micro-dollars in one dollar, for tests that read in dollars. */
const USD = 1_000_000

const alertDoc = (over: Record<string, unknown> = {}) => ({
  _id: 'alert-1',
  orgId: ORG_A,
  userId: null,
  agent: null,
  monthlyLimitMicros: 100 * USD,
  threshold: 0.8,
  trippedAt: null,
  createdAt: new Date('2026-01-01'),
  ...over,
})

/** The arguments of every call to one collection's operation, in order. */
const mongoCalls = (collection: string, op: string) =>
  mongoState.calls.filter((c) => c.collection === collection && c.op === op).map((c) => c.args)

/** What the month-to-date aggregation answers with, in micros. */
const spend = (micros: number) => {
  mongoState.aggregates.dailySnapshots = [{ _id: null, spend: micros }]
}

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
    const res = await get(auth(token()))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  // The IDOR fix every other dashboard route already applies: the query
  // string is not trusted for anything that decides whose data comes back.
  it('ignores an orgId supplied in the query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${url}?orgId=${ORG_B}`,
      headers: auth(token({ orgId: ORG_A })),
    })
    expect(res.statusCode).toBe(200)
    expect(mongoCalls('budgetAlerts', 'find')[0][0]).toEqual({ orgId: ORG_A })
    expect(inspect(mongoState.calls, { depth: null })).not.toContain(ORG_B)
  })

  it('reports tripped true only when trippedAt falls in the current calendar month', async () => {
    const now = new Date()
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5)
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 5)

    mongoState.docs.budgetAlerts = [
      alertDoc({ _id: 'alert-1', trippedAt: thisMonth }),
      alertDoc({ _id: 'alert-2', trippedAt: lastMonth }),
    ]
    spend(90 * USD)

    const res = await get(auth(token()))
    const body = res.json() as Array<Record<string, unknown>>

    expect(body.find((a) => a.id === 'alert-1')).toMatchObject({ tripped: true })
    expect(body.find((a) => a.id === 'alert-2')).toMatchObject({ tripped: false })
  })

  /**
   * Micros stop here. Everything under a handler works in whole micro-dollars,
   * and the two money fields on this response are the only place they turn
   * back into dollars. Dropping either conversion leaves the dashboard
   * rendering a limit of 100000000 next to a spend of 554220000.
   */
  it('renders the stored micros as dollars', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ monthlyLimitMicros: 100 * USD })]
    spend(554_220_000)

    const [row] = (await get(auth(token()))).json() as Array<Record<string, unknown>>
    expect(row).toMatchObject({ monthlyLimitUsd: 100, monthToDateSpendUsd: 554.22, threshold: 0.8 })
  })

  it('names the user a scoped alert belongs to', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ userId: USER_A })]
    mongoState.docs.users = [{ _id: USER_A, name: 'Alice Smith' }]
    spend(0)

    const [row] = (await get(auth(token()))).json() as Array<Record<string, unknown>>
    expect(row).toMatchObject({ userId: USER_A, userName: 'Alice Smith' })
  })

  // What the left join gave. A limit set against a user who has since been
  // removed still has to render, or the alert disappears from the panel that
  // is the only place it can be deleted.
  it('still renders a scoped alert whose user no longer exists', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ userId: USER_A })]
    mongoState.docs.users = []
    spend(0)

    const [row] = (await get(auth(token()))).json() as Array<Record<string, unknown>>
    expect(row).toMatchObject({ userId: USER_A, userName: null })
  })

  /**
   * PATCH accepts a userId without checking its org, where POST checks, so an
   * alert in this org can carry another org's user id. The name lookup must
   * not resolve it. Asserted on the filter because the fake answers every read
   * from what the test seeded, so the response alone cannot show the scope.
   */
  it('scopes the user name lookup to the caller org', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ userId: USER_A })]
    spend(0)

    await get(auth(token({ orgId: ORG_A })))

    expect(mongoCalls('users', 'find')[0][0]).toEqual({ _id: { $in: [USER_A] }, orgId: ORG_A })
  })

  it('reads month-to-date spend for the caller org and the alert scope only', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ userId: USER_A, agent: 'claude' })]
    spend(0)

    await get(auth(token({ orgId: ORG_A })))

    const [pipeline] = mongoCalls('dailySnapshots', 'aggregate')[0] as [{ $match?: unknown }[]]
    expect(pipeline[0].$match).toMatchObject({ orgId: ORG_A, userId: USER_A })
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
    const res = await post(auth(token({ role: 'admin' })))
    expect(res.statusCode).toBe(201)

    const [written] = mongoCalls('budgetAlerts', 'insertOne')[0] as [Record<string, unknown>]
    expect(res.json()).toEqual({ id: written._id })
    expect(written).toMatchObject({ orgId: ORG_A, userId: null, agent: null, trippedAt: null })
    // The ownership lookup is what an org-wide alert skips.
    expect(mongoCalls('users', 'findOne')).toHaveLength(0)
  })

  // The dollars the admin typed are stored as micros, and nothing below this
  // line ever sees a float again.
  it('stores the dollar limit as whole micros', async () => {
    await post(auth(token({ role: 'admin' })), { monthlyLimitUsd: 123.45 })
    const [written] = mongoCalls('budgetAlerts', 'insertOne')[0] as [Record<string, unknown>]
    expect(written.monthlyLimitMicros).toBe(123_450_000)
  })

  // The create route used to write the row and stop. An admin who set a limit
  // already below this month's spend was told OK, beside the very figure that
  // contradicted it, until the next agent sync happened to run the evaluator.
  it('evaluates the alert it just created, so a limit under current spend trips at once', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ monthlyLimitMicros: 1 * USD, threshold: 0.8 })]
    spend(554_220_000)

    const res = await post(auth(token({ role: 'admin' })), { monthlyLimitUsd: 1 })

    expect(res.statusCode).toBe(201)
    const [, update] = mongoCalls('budgetAlerts', 'updateOne')[0] as [unknown, { $set: Record<string, unknown> }]
    expect(update.$set.trippedAt).toBeInstanceOf(Date)
  })

  it('refuses a userId belonging to another organization, and writes nothing', async () => {
    mongoState.docs.users = [] // the ownership lookup matches nothing in this org
    const res = await post(auth(token({ role: 'admin' })), { monthlyLimitUsd: 500, userId: USER_A })
    expect(res.statusCode).toBe(400)
    expect(mongoCalls('budgetAlerts', 'insertOne')).toHaveLength(0)
    expect(mongoCalls('users', 'findOne')[0][0]).toEqual({ _id: USER_A, orgId: ORG_A })
  })

  it('creates a per-user alert once the user is confirmed in the caller org', async () => {
    mongoState.docs.users = [{ _id: USER_A }]
    const res = await post(auth(token({ role: 'admin' })), { monthlyLimitUsd: 500, userId: USER_A })
    expect(res.statusCode).toBe(201)
    const [written] = mongoCalls('budgetAlerts', 'insertOne')[0] as [Record<string, unknown>]
    expect(written.userId).toBe(USER_A)
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
    mongoState.docs.budgetAlerts = [] // the org-scoped lookup matches nothing
    const res = await patch(auth(token({ role: 'admin', orgId: ORG_B })))
    expect(res.statusCode).toBe(404)
    expect(mongoCalls('budgetAlerts', 'findOneAndUpdate')[0][0]).toEqual({ _id: ALERT_A, orgId: ORG_B })
  })

  it('updates the limit, in micros, and returns the alert id', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ _id: ALERT_A })]
    spend(0)
    const res = await patch(auth(token({ role: 'admin' })))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: ALERT_A })
    const [, update] = mongoCalls('budgetAlerts', 'findOneAndUpdate')[0] as [unknown, { $set: Record<string, unknown> }]
    expect(update.$set).toEqual({ monthlyLimitMicros: 250 * USD })
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
    mongoState.docs.budgetAlerts = [] // nothing matches the org-scoped filter
    const res = await del(auth(token({ role: 'admin', orgId: ORG_B })))
    expect(res.statusCode).toBe(404)
    expect(mongoCalls('budgetAlerts', 'deleteOne')[0][0]).toEqual({ _id: ALERT_A, orgId: ORG_B })
  })

  it('deletes and returns the alert id', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ _id: ALERT_A })]
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

  const enrichment = {
    date: DATE,
    sessionCount: 4,
    callCount: 31,
    cacheHitRate: 92.1,
    writtenTokens: 1234,
    activityBreakdown: [],
    projectBreakdown: [],
    topSessions: [],
    toolUsage: { bash: 5 },
    shellUsage: {},
    mcpUsage: {},
  }

  const deviceToken = () => token({ role: 'device', deviceId: DEVICE_A })

  /** The user row the snapshot rebuild reads to learn the org. */
  const knownUser = () => {
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A }]
  }

  const submit = (body: Record<string, unknown> = payload) =>
    app.inject({ method: 'POST', url: '/v1/usage', headers: auth(deviceToken()), payload: body })

  it('returns 401 without a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/usage', payload })
    expect(res.statusCode).toBe(401)
  })

  it('returns 403 when the payload deviceId does not match the token', async () => {
    liveDeviceToken()
    const res = await submit({ ...payload, deviceId: '55555555-5555-4555-8555-555555555555' })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('Device ID mismatch')
  })

  it('returns 400 on a payload that fails schema validation', async () => {
    liveDeviceToken()
    const res = await submit({ ...payload, events: [{ ...event, date: '20261105' }] })
    expect(res.statusCode).toBe(400)
  })

  it('accepts a submission and reports what was written', async () => {
    liveDeviceToken()
    knownUser()
    mongoState.bulk = { upsertedCount: 1, matchedCount: 0 }

    const res = await submit()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ accepted: 1, skipped: 0, date: DATE })
  })

  it('is idempotent: a replayed payload reports zero accepted, not an error', async () => {
    // The unique index on (userId, date, agent, modelName, deviceId, source)
    // makes the second write a match rather than an insert, and only an insert
    // is an acceptance on the device path.
    liveDeviceToken()
    knownUser()
    mongoState.bulk = { upsertedCount: 0, matchedCount: 1 }

    const res = await submit()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ accepted: 0, skipped: 1, date: DATE })
  })

  it('deduplicates with an upsert rather than a pre-read', async () => {
    liveDeviceToken()
    knownUser()
    await submit()

    const [ops] = mongoCalls('usageEvents', 'bulkWrite')[0] as [{ updateOne: Record<string, unknown> }[]]
    expect(ops).toHaveLength(1)
    expect(ops[0].updateOne.upsert).toBe(true)
    // First write wins on the device path: a matched document is left alone.
    expect(ops[0].updateOne.update).not.toHaveProperty('$set')
    expect(mongoCalls('usageEvents', 'find')).toHaveLength(0)
  })

  /**
   * Held on Postgres on purpose. routes/auth/device.ts reads `last_seen_at`
   * back for the admin and devices pages and does not move until Phase 5, so
   * writing it to Mongo now would put it in a store nothing reads and freeze
   * both pages at whatever Postgres last recorded.
   */
  it('touches the device on Postgres, where the pages that read it still look', async () => {
    liveDeviceToken()
    knownUser()
    await submit()

    const touch = dbState.calls.find(
      (c) => c.op === 'set' && c.arg !== null && typeof c.arg === 'object' && 'lastSeenAt' in c.arg,
    )
    expect((touch?.arg as { lastSeenAt: unknown })?.lastSeenAt).toBeInstanceOf(Date)
    expect(mongoCalls('devices', 'updateOne')).toHaveLength(0)
  })

  it('runs every write inside one transaction', async () => {
    liveDeviceToken()
    knownUser()
    await submit()

    const ops = mongoState.calls.map((c) => `${c.collection}.${c.op}`)
    // The event upsert, the device touch and the snapshot rebuild all land
    // after the transaction opens, so none of them can commit on its own.
    const opened = ops.indexOf('.transaction')
    expect(opened).toBeGreaterThanOrEqual(0)
    expect(opened).toBeLessThan(ops.indexOf('usageEvents.bulkWrite'))
    expect(opened).toBeLessThan(ops.indexOf('dailySnapshots.updateOne'))
    expect(ops).not.toContain('.rollback')
  })

  /**
   * The counters live only on the snapshot now, and this write is the only
   * thing that puts them there. A port that filled claudeEnrichment and
   * stopped would leave the dashboard reading zero calls and zero sessions
   * for every developer, with nothing raised, because zero is a real value.
   */
  it('lands the enrichment counters on the snapshot, not only the blobs', async () => {
    liveDeviceToken()
    knownUser()
    await submit({ ...payload, enrichment })

    expect(mongoCalls('claudeEnrichment', 'updateOne')).toHaveLength(1)
    const counters = (mongoCalls('dailySnapshots', 'updateOne') as [unknown, { $set: Record<string, unknown> }][])
      .map(([, update]) => update.$set)
      .find((set) => 'callCount' in set)
    expect(counters).toEqual({
      callCount: 31,
      sessionCount: 4,
      cacheHitRate: 92.1,
      // Both writes set it: it records when the document was last written, so
      // an enrichment that moves three counters and leaves it alone would be
      // lying about its own freshness.
      updatedAt: expect.any(Date),
    })
  })

  /**
   * The enrichment keys the snapshot off the date the rest of the transaction
   * is using, never `enrichment.date` — the schema validates the two
   * separately and does not require them to agree. Taking the client's would
   * create a snapshot document for a day no rebuild ever runs against, and
   * overwrite that day's counters if one already existed.
   */
  it('keys the enrichment off the submission date, not the one inside the enrichment', async () => {
    liveDeviceToken()
    knownUser()
    await submit({ ...payload, enrichment: { ...enrichment, date: '2026-03-17' } })

    for (const collection of ['claudeEnrichment', 'dailySnapshots']) {
      for (const [filter] of mongoCalls(collection, 'updateOne') as [{ _id: string }][]) {
        expect(filter._id).toBe(`${USER_A}:${DATE}`)
      }
    }
  })

  /**
   * `users` is read by the rebuild to learn the org, and nothing populates
   * that collection yet. A guard that returned quietly would answer
   * `{accepted: 1}` for a submission whose snapshot was never written and
   * whose budget alerts can never trip.
   */
  it('fails the request, and rolls back, when the user is absent from the store', async () => {
    liveDeviceToken()
    mongoState.docs.users = []

    const res = await submit()

    expect(res.statusCode).toBe(500)
    expect(mongoState.calls.map((c) => c.op)).toContain('rollback')
  })

  it('rolls back and fails the request when the snapshot rebuild throws', async () => {
    // Previously this returned 200 with the events written and the snapshot
    // stale, and nothing retried it. Now the whole submission is undone, so the
    // agent's next run re-sends it. The user row has to be present or the
    // rebuild returns early and never reaches the write that fails.
    liveDeviceToken()
    knownUser()
    mongoState.failOn = 'dailySnapshots.updateOne'

    const res = await submit({ ...payload, enrichment: null })

    expect(res.statusCode).toBe(500)
    expect(mongoState.calls.map((c) => c.op)).toContain('rollback')
  })

  it('evaluates budget alerts inside the same transaction, scoped to the caller org', async () => {
    liveDeviceToken()
    knownUser()
    mongoState.docs.budgetAlerts = [alertDoc({ monthlyLimitMicros: 10 * USD, threshold: 1 })]
    spend(10 * USD) // exactly the trip point

    const res = await submit({ ...payload, enrichment: null })

    expect(res.statusCode).toBe(200)
    const ops = mongoState.calls.map((c) => `${c.collection}.${c.op}`)
    expect(ops).not.toContain('.rollback')
    // The alert update lands after the rebuild's own upsert, inside the one
    // transaction the whole submission runs in.
    expect(ops.indexOf('dailySnapshots.updateOne')).toBeLessThan(ops.indexOf('budgetAlerts.updateOne'))

    const [, update] = mongoCalls('budgetAlerts', 'updateOne')[0] as [unknown, { $set: Record<string, unknown> }]
    expect(update.$set.trippedAt).toBeInstanceOf(Date)
    // The alert lookup itself must be scoped to the caller's org, the same
    // posture every dashboard route takes.
    expect(mongoCalls('budgetAlerts', 'find')[0][0]).toMatchObject({ orgId: ORG_A })
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
    // The rebuild reads the user to learn the org and aborts the transaction
    // when it is absent, so a submission that is meant to reach 200 needs one.
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A }]

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
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A }]

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
  // Both checks draw from the fake's one result queue, and the schema check
  // takes the first slot even though it is second in the list: it awaits its
  // query while being evaluated as an argument, whereas the `select 1` proxy
  // does not shift until allSettled attaches a handler. Queue order follows
  // who awaits first, not who is written first.
  const schemaThenLiveness = (latest: number) => {
    dbState.results.push([{ latest }])
    dbState.results.push([]) // select 1 — the value is never read
  }

  // build-server skips both MongoDB checks when MONGODB_URI is unset, and
  // vitest never sets it. Every case below except the last is about what
  // happens once Mongo IS configured, so the variable is present for all of
  // them. The value is never dialled — @burn-watch/db is mocked wholesale.
  beforeEach(() => {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/burnwatch_test'
  })

  afterEach(() => {
    delete process.env.MONGODB_URI
  })

  it('needs no authentication and returns 200 when the database answers', async () => {
    schemaThenLiveness(EXPECTED_SCHEMA_VERSION)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('returns 503 naming the database when the database is down', async () => {
    dbState.failExecute = true
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    // Both checks go through execute, so a dead database fails both. The point
    // of the list is that it names every failure rather than the first.
    expect(res.json().ok).toBe(false)
    expect(res.json().failed).toContain('database')
  })

  /**
   * BW-37. A reachable database running a schema older than the code used to
   * answer `{ok:true}` here, and did for 22 hours while every usage
   * submission failed on a column that was never applied. Reverting the
   * second check in build-server turns this green-on-broken again.
   */
  it('returns 503 naming the schema when the database is behind the code', async () => {
    schemaThenLiveness(EXPECTED_SCHEMA_VERSION - 1)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ok: false, failed: ['schema'] })
  })

  it('names a never-migrated database too, not just one a version behind', async () => {
    schemaThenLiveness(0)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json().failed).toContain('schema')
  })

  it('leaks no connection details into the response body', async () => {
    // The driver error carries the host it failed to reach.
    dbState.failExecute = true
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.payload).not.toContain('db.example')
  })

  it('returns 503 naming mongo when the MongoDB ping fails', async () => {
    schemaThenLiveness(EXPECTED_SCHEMA_VERSION)
    mongoState.pingFails = true
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ok: false, failed: ['mongo'] })
    expect(res.payload).not.toContain('mongo.example')
  })

  /**
   * BW-37's shape on a database that will not raise it for us. A missing
   * usageEvents_key unique index fails no query at all, it only stops the
   * two-tier upsert deduplicating, so a check that does not read the live
   * index list would answer 200 while every re-sync inserted duplicates.
   */
  it('returns 503 naming mongoSchema when the MongoDB shape has drifted', async () => {
    schemaThenLiveness(EXPECTED_SCHEMA_VERSION)
    mongoState.schemaFails = true
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ok: false, failed: ['mongoSchema'] })
    // The drift text names collections and indexes, and goes to the log only.
    expect(res.payload).not.toContain('usageEvents_key')
  })

  it('names every failed dependency rather than the first', async () => {
    schemaThenLiveness(EXPECTED_SCHEMA_VERSION - 1)
    mongoState.pingFails = true
    mongoState.schemaFails = true
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toEqual({ ok: false, failed: ['schema', 'mongo', 'mongoSchema'] })
  })

  /**
   * The inverse of the case that stood here through Phases 2 and 3, which
   * asserted that both MongoDB checks are skipped when MONGODB_URI is unset.
   *
   * That was right while nothing in a request path read Mongo. It stopped
   * being right at Phase 3, and Phase 4 made it acute: fifteen handlers call
   * getStore(), which throws outright when the variable is unset. Checked
   * against the branch preview, where the variable is set in no environment —
   * /health answered 200 {"ok":true} while all five dashboard routes answered
   * 500. The endpoint was certifying a deployment that could not serve a page.
   *
   * Both mocks are left healthy, so the only thing that can fail this case is
   * the missing variable itself.
   */
  it('reports mongo down when MONGODB_URI is unset, because handlers need it', async () => {
    delete process.env.MONGODB_URI
    schemaThenLiveness(EXPECTED_SCHEMA_VERSION)

    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ok: false, failed: ['mongo', 'mongoSchema'] })
  })
})

describe('unhandled errors', () => {
  // The dashboard's `apiFetch` surfaces `{ error }` from every failed read, so
  // whatever this handler writes into the body is rendered in an admin's
  // browser. Built per test: a route cannot be added to `app` once it is ready.
  const serve = async (thrown: Error) => {
    const server = buildServer()
    server.get('/throws', async () => {
      throw thrown
    })
    await server.ready()
    const logged = vi.spyOn(server.log, 'error')
    const res = await server.inject({ method: 'GET', url: '/throws' })
    await server.close()
    return { res, logged }
  }

  it('answers 500 with a fixed sentence and keeps the thrown message for the log', async () => {
    // What a Drizzle or Postgres failure looks like: table names at least,
    // and sometimes row values.
    const thrown = new Error('relation "usage_events" does not exist')

    const { res, logged } = await serve(thrown)

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'Internal server error' })
    expect(res.payload).not.toContain('usage_events')
    expect(logged).toHaveBeenCalledWith(thrown)
  })

  it('still carries the message of an error that chose a status under 500', async () => {
    // Fastify's auth and rate-limit errors arrive this way, and tests
    // elsewhere pin some of their sentences.
    const thrown = Object.assign(new Error('that handle is taken'), { statusCode: 409 })

    const { res } = await serve(thrown)

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'that handle is taken' })
  })
})
