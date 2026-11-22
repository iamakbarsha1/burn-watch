import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import type { TeamComparison } from '@burn-watch/shared'
import type { JwtPayload } from '../plugins/jwt.js'
import { callsTo } from '../mongo-store.fake.js'
import { daysBefore, today } from './dashboard/dates.js'

process.env.JWT_SECRET ??= 'test-access-secret'
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret'

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
 * touches `/health`, turning the healthy case into a 503, which is exactly the
 * kind of coupling that makes a health assertion stop meaning anything.
 */
const mongoState = vi.hoisted(() => ({
  pingFails: false,
  schemaFails: false,
  docs: {} as Record<string, Record<string, unknown>[]>,
  aggregates: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as { op: string; collection: string; args: unknown[] }[],
  failOn: null as string | null,
  bulk: { upsertedCount: 1, matchedCount: 0 },
  claimOnce: [] as string[],
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
const { getStore } = await import('@burn-watch/db')

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const USER_A = '33333333-3333-4333-8333-333333333333'
const USER_B = '77777777-7777-4777-8777-777777777777'
const TEAM_A = '88888888-8888-4888-8888-888888888888'
const TEAM_B = '99999999-9999-4999-8999-999999999999'
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

// A device-role token is only good while its deviceTokens document is
// unrevoked, so every device-authenticated request reads it before the route's
// own queries. The fake ignores filters, so seeding one makes the guard pass.
const liveDeviceToken = () => {
  mongoState.docs.deviceTokens = [{ _id: 'token-1', deviceId: DEVICE_A, revokedAt: null }]
}

/**
 * Every `userId` filter the data reads used, skipping the team lookups that
 * resolve scope. Group keys (`'$userId'`) and projections (`1`) are not filters.
 */
function userFilters(): unknown[] {
  const out: unknown[] = []
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (!n || typeof n !== 'object') return
    for (const [k, v] of Object.entries(n)) {
      if (k === 'userId' && typeof v === 'object' && v !== null) out.push(v)
      else if (k === 'userId' && typeof v === 'string' && !v.startsWith('$')) out.push(v)
      else walk(v)
    }
  }
  for (const c of mongoState.calls) if (c.collection !== 'teams' && c.collection !== 'teamMembers') walk(c.args)
  return out
}

/** Reads of `deviceTokens`. Every device-authenticated request pays for these,
 * so the count is the guard's price on the hot path. */
const deviceTokenReads = () =>
  mongoState.calls.filter((c) => c.collection === 'deviceTokens' && c.op === 'findOne')

/** The filter of the guard's lookup. */
const guardFilter = () => deviceTokenReads()[0]?.args[0] as Record<string, unknown> | undefined

beforeEach(async () => {
  mongoState.pingFails = false
  mongoState.schemaFails = false
  mongoState.docs = {}
  mongoState.aggregates = {}
  mongoState.calls = []
  mongoState.failOn = null
  mongoState.bulk = { upsertedCount: 1, matchedCount: 0 }
  mongoState.claimOnce = []
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

describe('dashboard routes — viewer scoping', () => {
  const SCOPED_URLS = [...DASHBOARD_ROUTES.map(range), '/v1/dashboard/budget-alerts']

  // A manager of TEAM_A, which also holds USER_B.
  const managerOfTeam = () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { _id: `${TEAM_A}:${USER_A}`, teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { _id: `${TEAM_A}:${USER_B}`, teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
  }

  async function expectScope(url: string, role: JwtPayload['role'], ids: string[] | undefined) {
    mongoState.calls.length = 0
    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role })) })
    expect(res.statusCode, url).toBe(200)
    const filters = userFilters()
    if (ids === undefined) expect(filters, url).toEqual([])
    else {
      expect(filters.length, url).toBeGreaterThan(0)
      for (const f of filters) expect(f, url).toEqual({ $in: ids })
    }
  }

  it.each(SCOPED_URLS)('limits a developer to their own user on %s', async (url) => {
    managerOfTeam() // team rows must not widen a developer, even one marked manager
    await expectScope(url, 'developer', [USER_A])
  })

  it.each(SCOPED_URLS)('limits a manager with no team to their own user on %s', async (url) => {
    await expectScope(url, 'manager', [USER_A])
  })

  it.each(SCOPED_URLS)('widens a manager to their team on %s', async (url) => {
    managerOfTeam()
    await expectScope(url, 'manager', [USER_A, USER_B])
  })

  it('reads team rows only within the caller org, and only managed teams', async () => {
    managerOfTeam()
    await app.inject({ method: 'GET', url: range('/v1/dashboard/overview'), headers: auth(token({ role: 'manager' })) })
    const [first, second] = callsTo(mongoState, 'teamMembers', 'find')
    expect(first[0]).toEqual({ orgId: ORG_A, userId: USER_A, role: 'manager' })
    // The fake ignores filters, so which teams the $in names is a fake artifact; the org is not.
    expect(second[0]).toMatchObject({ orgId: ORG_A })
  })

  it.each(SCOPED_URLS)('lets an admin read the whole org on %s', async (url) => {
    managerOfTeam()
    await expectScope(url, 'admin', undefined)
    expect(inspect(mongoState.calls, { depth: null }), url).not.toContain(USER_A)
  })
})

describe('dashboard routes — team filter', () => {
  const TEAM_ROUTES = ['/v1/dashboard/overview', '/v1/dashboard/trends']
  const withTeam = (url: string, team = TEAM_A) => `${range(url)}&teamId=${team}`
  const get = (url: string, role: JwtPayload['role']) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  // Overview reads usage and seats, so it filters twice, both on the same ids.
  const expectOnly = (ids: string[]) => {
    const filters = userFilters()
    expect(filters.length).toBeGreaterThan(0)
    for (const f of filters) expect(f).toEqual({ $in: ids })
  }

  it.each(TEAM_ROUTES)('%s narrows an admin to the team members', async (url) => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
    const res = await get(withTeam(url), 'admin')
    expect(res.statusCode).toBe(200)
    expectOnly([USER_B])
    // The team lookup is org-scoped, so another org's team id answers 404.
    expect(callsTo(mongoState, 'teams', 'findOne')[0][0]).toEqual({ _id: TEAM_A, orgId: ORG_A })
  })

  it.each(TEAM_ROUTES)('%s gives a manager their whole managed team', async (url) => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
    const res = await get(withTeam(url), 'manager')
    expect(res.statusCode).toBe(200)
    expectOnly([USER_A, USER_B])
  })

  it.each(TEAM_ROUTES)('%s answers 403 to a manager filtering a team they do not manage', async (url) => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [{ teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'manager' }]
    const res = await get(withTeam(url), 'manager')
    expect(res.statusCode).toBe(403)
    expect(callsTo(mongoState, 'dailySnapshots', 'aggregate')).toEqual([])
  })

  it.each(TEAM_ROUTES)('%s keeps a developer in their own team to themselves', async (url) => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
    const res = await get(withTeam(url), 'developer')
    expect(res.statusCode).toBe(200)
    expectOnly([USER_A])
  })

  it.each(TEAM_ROUTES)('%s answers 404 for a team not in the org', async (url) => {
    const res = await get(withTeam(url), 'admin')
    expect(res.statusCode).toBe(404)
  })

  it.each(TEAM_ROUTES)('%s rejects a teamId that is not a uuid', async (url) => {
    const res = await get(withTeam(url, 'not-a-team'), 'admin')
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /v1/dashboard/teams/compare', () => {
  const url = range('/v1/dashboard/teams/compare')
  const get = (role: JwtPayload['role']) => app.inject({ method: 'GET', url, headers: auth(token({ role })) })

  it('refuses a developer', async () => {
    expect((await get('developer')).statusCode).toBe(403)
  })

  it('returns nothing when the viewer can compare no team', async () => {
    const res = await get('manager')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    expect(callsTo(mongoState, 'dailySnapshots', 'aggregate')).toEqual([])
  })

  it('sums each team from its members, counting a shared member in both', async () => {
    mongoState.docs.teams = [
      { _id: TEAM_A, orgId: ORG_A, name: 'Platform' },
      { _id: TEAM_B, orgId: ORG_A, name: 'Mobile' },
    ]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      { teamId: TEAM_B, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
    mongoState.aggregates.dailySnapshots = [
      {
        users: [
          { _id: USER_A, costMicros: 1_500_000, tokens: 10 },
          { _id: USER_B, costMicros: 2_000_000, tokens: 20 },
        ],
        agents: [
          { _id: { userId: USER_A, agent: 'claude' }, tokens: 10, costMicros: 1_500_000 },
          { _id: { userId: USER_B, agent: 'claude' }, tokens: 5, costMicros: 500_000 },
          { _id: { userId: USER_B, agent: 'codex' }, tokens: 15, costMicros: 1_500_000 },
        ],
        daily: [
          { userId: USER_A, date: DATE, totalCostMicros: 1_500_000 },
          { userId: USER_B, date: DATE, totalCostMicros: 2_000_000 },
        ],
      },
    ]

    const res = await get('admin')
    expect(res.statusCode).toBe(200)
    const [platform, mobile] = res.json() as TeamComparison[]
    expect(platform).toMatchObject({ teamId: TEAM_A, memberCount: 2, activeUsers: 2, totalCostUsd: 3.5, totalTokens: 30 })
    expect(platform.daily).toEqual([{ date: DATE, totalCost: 3.5 }])
    expect(platform.byAgent.find((a) => a.agent === 'claude')).toMatchObject({ tokens: 15, costUsd: 2 })
    expect(mobile).toMatchObject({ teamId: TEAM_B, memberCount: 1, activeUsers: 1, totalCostUsd: 2, totalTokens: 20 })
    expect(mobile.byAgent.find((a) => a.agent === 'claude')).toMatchObject({ tokens: 5, costUsd: 0.5 })

    // One read, over the union of members, inside the caller's org.
    const [[pipeline]] = callsTo(mongoState, 'dailySnapshots', 'aggregate') as Document[][][]
    expect(pipeline[0].$match).toMatchObject({ orgId: ORG_A, userId: { $in: [USER_A, USER_B] } })
  })

  it('limits a manager to the teams they manage', async () => {
    await get('manager')
    expect(callsTo(mongoState, 'teamMembers', 'find')[0][0]).toEqual({ orgId: ORG_A, userId: USER_A, role: 'manager' })
  })
})

describe('team management routes', () => {
  const send = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, role: JwtPayload['role'] = 'admin') =>
    app.inject({ method, url, payload, headers: auth(token({ role })) })
  const member = `/v1/dashboard/teams/${TEAM_A}/members/${USER_B}`

  it.each([
    ['POST', '/v1/dashboard/teams', { name: 'x' }],
    ['PATCH', `/v1/dashboard/teams/${TEAM_A}`, { name: 'x' }],
    ['DELETE', `/v1/dashboard/teams/${TEAM_A}`, undefined],
    ['PUT', member, { role: 'member' }],
    ['DELETE', member, undefined],
  ] as const)('%s %s is admin only', async (method, url, payload) => {
    const res = await send(method, url, payload, 'manager')
    expect(res.statusCode).toBe(403)
    expect(mongoState.calls).toEqual([])
  })

  it('creates a team in the caller org', async () => {
    const res = await send('POST', '/v1/dashboard/teams', { name: '  Platform ' })
    expect(res.statusCode).toBe(201)
    expect(callsTo(mongoState, 'teams', 'insertOne')[0][0]).toMatchObject({ orgId: ORG_A, name: 'Platform' })
  })

  it('rejects an empty team name', async () => {
    const res = await send('POST', '/v1/dashboard/teams', { name: '  ' })
    expect(res.statusCode).toBe(400)
  })

  it('renames only a team in the caller org', async () => {
    const res = await send('PATCH', `/v1/dashboard/teams/${TEAM_A}`, { name: 'Core' })
    expect(res.statusCode).toBe(404)
    expect(callsTo(mongoState, 'teams', 'findOneAndUpdate')[0][0]).toEqual({ _id: TEAM_A, orgId: ORG_A })
  })

  it('deletes members before the team, both inside the caller org', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    const res = await send('DELETE', `/v1/dashboard/teams/${TEAM_A}`)
    expect(res.statusCode).toBe(200)
    const ops = mongoState.calls.map((c) => `${c.collection}.${c.op}`)
    expect(ops).toEqual(['teamMembers.deleteMany', 'teams.deleteOne'])
    expect(callsTo(mongoState, 'teamMembers', 'deleteMany')[0][0]).toEqual({ teamId: TEAM_A, orgId: ORG_A })
  })

  it('refuses to add a user from another org', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    const res = await send('PUT', member, { role: 'member' })
    expect(res.statusCode).toBe(400)
    expect(callsTo(mongoState, 'users', 'findOne')[0][0]).toEqual({ _id: USER_B, orgId: ORG_A })
    expect(callsTo(mongoState, 'teamMembers', 'updateOne')).toEqual([])
  })

  it('answers 404 when adding to a team not in the org', async () => {
    const res = await send('PUT', member, { role: 'member' })
    expect(res.statusCode).toBe(404)
  })

  it('upserts a membership keyed by team and user', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.users = [{ _id: USER_B, orgId: ORG_A }]
    const res = await send('PUT', member, { role: 'manager' })
    expect(res.statusCode).toBe(200)
    const [[filter, update, opts]] = callsTo(mongoState, 'teamMembers', 'updateOne') as Document[][]
    expect(filter).toEqual({ _id: `${TEAM_A}:${USER_B}` })
    expect(update).toMatchObject({
      $set: { role: 'manager' },
      $setOnInsert: { teamId: TEAM_A, orgId: ORG_A, userId: USER_B },
    })
    expect(opts).toEqual({ upsert: true })
  })

  it('rejects an unknown role', async () => {
    const res = await send('PUT', member, { role: 'owner' })
    expect(res.statusCode).toBe(400)
  })

  it('removes a membership only inside the caller org', async () => {
    const res = await send('DELETE', member)
    expect(res.statusCode).toBe(404)
    expect(callsTo(mongoState, 'teamMembers', 'deleteOne')[0][0]).toEqual({ _id: `${TEAM_A}:${USER_B}`, orgId: ORG_A })
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

  it('runs on a server with no Postgres handle at all', () => {
    // The point of the migration. A route left half-ported reads its totals
    // from one store and its names from the other, and the two disagree
    // silently. With no `db` decorator there is no second store to read.
    expect(app.hasDecorator('db')).toBe(false)
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

  // `days` is the branch the dashboard's own links use, and the shared `range()`
  // helper every other case here goes through sends `from`+`to`, so until this
  // was written the whole else-branch computing the window was never executed
  // by the suite. A sign flip there asks for the next N days and always answers
  // with an empty chart — which looks exactly like a quiet month.
  const windowOf = () => {
    const [pipeline] = mongoCalls('dailySnapshots', 'aggregate')[0] as [Record<string, never>[]]
    return (pipeline[0] as unknown as { $match: { date: { $gte: string; $lte: string } } }).$match
      .date
  }

  it.each([7, 30, 90])('derives a %i-day window backwards from today', async (days) => {
    await app.inject({
      method: 'GET',
      url: `/v1/dashboard/trends?days=${days}`,
      headers: auth(token()),
    })
    expect(windowOf()).toEqual({ $gte: daysBefore(today(), days), $lte: today() })
  })

  it('answers 400, rather than picking a window, when the request names none', async () => {
    // Worth pinning next to the cases above: the handler carries a `?? 30`
    // that looks like a default and is unreachable, because the schema refines
    // to `days || (from && to)`. Anyone reading the handler alone would take
    // that fallback for live behaviour and test it.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/trends',
      headers: auth(token()),
    })
    expect(res.statusCode).toBe(400)
    expect(mongoCalls('dailySnapshots', 'aggregate')).toEqual([])
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
      { path: 'acme/widgets', remote: null, totalCost: 15, totalSessions: 6, userCount: 2, ...over },
    ])

  it('passes the folded figures through and adds the derived average', async () => {
    totals()
    expect((await get()).json()).toEqual([
      {
        path: 'acme/widgets',
        remote: null,
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

/** What the per-user month-to-date aggregation answers with, in micros: one user, all on claude. */
const spend = (micros: number) => {
  mongoState.aggregates.dailySnapshots = [{ _id: USER_A, total: micros, claude: micros }]
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
      headers: auth(token({ role: 'admin', orgId: ORG_A })),
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

describe('seat routes', () => {
  const one = `/v1/dashboard/seats/${USER_B}/claude`
  const send = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, role: JwtPayload['role'] = 'admin') =>
    app.inject({ method, url, payload, headers: auth(token({ role })) })
  const price = { monthlyPriceUsd: 30, startDate: '2026-11-01' }

  it.each(['developer', 'manager'] as const)('answers 403 to a %s on every seat route, and reads nothing', async (role) => {
    for (const [method, url, payload] of [
      ['GET', '/v1/dashboard/seats', undefined],
      ['PUT', one, price],
      ['DELETE', one, undefined],
      ['POST', '/v1/dashboard/seats/assign-all', { ...price, agent: 'claude' }],
    ] as const) {
      const res = await send(method, url, payload, role)
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    expect(mongoState.calls).toEqual([])
  })

  it('lists the org seats with the holder name and email, in dollars', async () => {
    mongoState.docs.seats = [
      { _id: `${USER_B}:claude`, orgId: ORG_A, userId: USER_B, agent: 'claude', monthlyPriceMicros: 30 * USD, startDate: '2026-11-01', createdAt: new Date('2026-11-01') },
    ]
    mongoState.docs.users = [{ _id: USER_B, name: 'Bo', email: 'bo@example.com' }]
    const res = await send('GET', '/v1/dashboard/seats')
    expect(res.json()).toEqual([
      { userId: USER_B, userName: 'Bo', userEmail: 'bo@example.com', agent: 'claude', monthlyPriceUsd: 30, startDate: '2026-11-01', createdAt: '2026-11-01T00:00:00.000Z' },
    ])
    expect(mongoCalls('seats', 'find')[0][0]).toEqual({ orgId: ORG_A })
    expect(mongoCalls('users', 'find')[0][0]).toMatchObject({ orgId: ORG_A })
  })

  it('refuses to seat a user from another org, and writes nothing', async () => {
    const res = await send('PUT', one, price)
    expect(res.statusCode).toBe(400)
    expect(mongoCalls('users', 'findOne')[0][0]).toEqual({ _id: USER_B, orgId: ORG_A })
    expect(mongoCalls('seats', 'updateOne')).toEqual([])
  })

  it('rejects an agent outside the five', async () => {
    const res = await send('PUT', `/v1/dashboard/seats/${USER_B}/cursor`, price)
    expect(res.statusCode).toBe(400)
  })

  it('upserts the seat keyed by user and agent, in micros', async () => {
    mongoState.docs.users = [{ _id: USER_B, orgId: ORG_A }]
    const res = await send('PUT', one, { ...price, monthlyPriceUsd: 19.99 })
    expect(res.statusCode).toBe(200)
    const [[filter, update, opts]] = mongoCalls('seats', 'updateOne') as Document[][]
    expect(filter).toEqual({ _id: `${USER_B}:claude` })
    expect(update).toMatchObject({
      $set: { monthlyPriceMicros: 19_990_000, startDate: '2026-11-01' },
      $setOnInsert: { orgId: ORG_A, userId: USER_B, agent: 'claude' },
    })
    expect(opts).toEqual({ upsert: true })
  })

  it('re-evaluates the org alerts inside the same transaction as the seat write', async () => {
    mongoState.docs.users = [{ _id: USER_B, orgId: ORG_A }]
    mongoState.docs.budgetAlerts = [alertDoc({ type: 'api-spend', monthlyLimitMicros: 10 * USD, threshold: 1 })]
    spend(10 * USD)
    const res = await send('PUT', one, price)
    expect(res.statusCode).toBe(200)
    const ops = mongoState.calls.map((c) => `${c.collection}.${c.op}`)
    expect(ops.indexOf('.transaction')).toBeLessThan(ops.indexOf('seats.updateOne'))
    expect(ops.indexOf('seats.updateOne')).toBeLessThan(ops.indexOf('budgetAlerts.updateOne'))
    expect(mongoCalls('budgetAlerts', 'find')[0][0]).toEqual({ orgId: ORG_A, type: { $ne: 'limit-hit' } })
    const [, update] = mongoCalls('budgetAlerts', 'updateOne')[0] as [unknown, { $set: Record<string, unknown> }]
    expect(update.$set.trippedAt).toBeInstanceOf(Date)
  })

  it('deletes only inside the caller org, and answers 404 when nothing matched', async () => {
    const res = await send('DELETE', one)
    expect(res.statusCode).toBe(404)
    expect(mongoCalls('seats', 'deleteOne')[0][0]).toEqual({ _id: `${USER_B}:claude`, orgId: ORG_A })
    expect(mongoCalls('budgetAlerts', 'find')).toEqual([])
  })

  it('assign-all seats only active users without one, never overwriting', async () => {
    mongoState.docs.users = [{ _id: USER_A }, { _id: USER_B }]
    mongoState.docs.seats = [{ _id: `${USER_A}:claude`, orgId: ORG_A, userId: USER_A, agent: 'claude' }]
    const res = await send('POST', '/v1/dashboard/seats/assign-all', { ...price, agent: 'claude' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ created: 1 })
    expect(mongoCalls('users', 'find')[0][0]).toEqual({ orgId: ORG_A, isActive: true })
    expect(mongoCalls('seats', 'find')[0][0]).toEqual({ orgId: ORG_A, agent: 'claude' })
    const [[ops]] = mongoCalls('seats', 'bulkWrite') as Document[][][]
    expect(ops).toHaveLength(1)
    expect(ops[0].updateOne.filter).toEqual({ _id: `${USER_B}:claude` })
    expect(Object.keys(ops[0].updateOne.update)).toEqual(['$setOnInsert'])
  })

  it('assign-all writes nothing when everyone already has a seat', async () => {
    mongoState.docs.users = [{ _id: USER_A }]
    mongoState.docs.seats = [{ _id: `${USER_A}:claude`, orgId: ORG_A, userId: USER_A, agent: 'claude' }]
    const res = await send('POST', '/v1/dashboard/seats/assign-all', { ...price, agent: 'claude' })
    expect(res.json()).toEqual({ created: 0 })
    expect(mongoCalls('seats', 'bulkWrite')).toEqual([])
  })
})

describe('actual cost', () => {
  // $36.50/mo is $1.20 a day. DATE is one day, inside the seat.
  const seat = (userId: string, agent: string) => ({
    _id: `${userId}:${agent}`, orgId: ORG_A, userId, agent, monthlyPriceMicros: 36_500_000, startDate: '2026-11-01',
  })

  it('splits overview value into seat cost and unseated API spend', async () => {
    dashboardAggregate('dailySnapshots', [
      {
        totals: [{ costMicros: 12 * USD, tokens: 400, activeUsers: 2 }],
        byAgent: [],
        pairs: [
          { _id: { userId: USER_A, agent: 'claude' }, costMicros: 10 * USD },
          { _id: { userId: USER_B, agent: 'codex' }, costMicros: 2 * USD },
        ],
      },
    ])
    mongoState.docs.seats = [seat(USER_A, 'claude')]
    const body = (await app.inject({ method: 'GET', url: range('/v1/dashboard/overview'), headers: auth(token({ role: 'admin' })) })).json()
    expect(body.valueUsd).toBe(12)
    expect(body.actualCost).toEqual({ seatUsd: 1.2, apiUsd: 2, totalUsd: 3.2, seatCount: 1, monthlySeatUsd: 36.5 })
    expect(mongoCalls('seats', 'find')[0][0]).toEqual({ orgId: ORG_A })
  })

  it('limits a manager overview to the seats of the people in scope', async () => {
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
    await app.inject({ method: 'GET', url: range('/v1/dashboard/overview'), headers: auth(token({ role: 'manager' })) })
    expect(mongoCalls('seats', 'find')[0][0]).toEqual({ orgId: ORG_A, userId: { $in: [USER_A, USER_B] } })
  })

  it('gives each leaderboard row its actual cost and value multiple', async () => {
    dashboardAggregate('dailySnapshots', [
      {
        users: [
          { _id: USER_A, totalCostMicros: 12 * USD, totalTokens: 1, sessions: 1 },
          { _id: USER_B, totalCostMicros: 0, totalTokens: 1, sessions: 1 },
        ],
        agents: [
          { _id: { userId: USER_A, agent: 'claude' }, tokens: 1, costMicros: 10 * USD },
          { _id: { userId: USER_A, agent: 'codex' }, tokens: 1, costMicros: 2 * USD },
        ],
        everyone: [{ ids: [USER_A, USER_B] }],
      },
    ])
    mongoState.docs.users = [
      { _id: USER_A, name: 'Ada', email: 'a@example.com' },
      { _id: USER_B, name: 'Bo', email: 'b@example.com' },
    ]
    mongoState.docs.seats = [seat(USER_A, 'claude')]
    const [ada, bo] = (await app.inject({ method: 'GET', url: range('/v1/dashboard/leaderboard'), headers: auth(token({ role: 'admin' })) })).json()
    expect(ada).toMatchObject({ totalCostUsd: 12, apiSpendUsd: 2, actualCostUsd: 3.2, valueMultiple: 3.75 })
    expect(bo).toMatchObject({ apiSpendUsd: 0, actualCostUsd: 0, valueMultiple: null })
    expect(mongoCalls('seats', 'find')[0][0]).toEqual({ orgId: ORG_A, userId: { $in: [USER_A, USER_B] } })
  })
})

describe('budget alert types', () => {
  const post = (payload: object) =>
    app.inject({ method: 'POST', url: '/v1/dashboard/budget-alerts', payload, headers: auth(token({ role: 'admin' })) })

  it.each([
    [{ type: 'api-spend' }, 'monthlyLimitUsd'],
    [{ type: 'idle-seat' }, 'idleDays'],
    [{ type: 'limit-hit' }, 'limitHits'],
  ])('refuses %o without %s', async (payload, field) => {
    const res = await post(payload)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain(field)
    expect(mongoCalls('budgetAlerts', 'insertOne')).toEqual([])
  })

  it('rejects idleDays that is not a whole number of at least 1', async () => {
    expect((await post({ type: 'idle-seat', idleDays: 0 })).statusCode).toBe(400)
    expect((await post({ type: 'idle-seat', idleDays: 1.5 })).statusCode).toBe(400)
  })

  it('stores an idle-seat alert with only its own field', async () => {
    const res = await post({ type: 'idle-seat', idleDays: 14, monthlyLimitUsd: 99, limitHits: 3 })
    expect(res.statusCode).toBe(201)
    const [written] = mongoCalls('budgetAlerts', 'insertOne')[0] as [Record<string, unknown>]
    expect(written).toMatchObject({ type: 'idle-seat', idleDays: 14, limitHits: null, monthlyLimitMicros: 0 })
  })

  it('defaults a create with no type to api-spend, as older dashboards send', async () => {
    await post({ monthlyLimitUsd: 50 })
    const [written] = mongoCalls('budgetAlerts', 'insertOne')[0] as [Record<string, unknown>]
    expect(written).toMatchObject({ type: 'api-spend', monthlyLimitMicros: 50 * USD, idleDays: null, limitHits: null })
  })

  it('refuses a patch that switches type without the field the new type needs', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ _id: ALERT_A })]
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/dashboard/budget-alerts/${ALERT_A}`,
      payload: { type: 'limit-hit' },
      headers: auth(token({ role: 'admin' })),
    })
    expect(res.statusCode).toBe(400)
    expect(mongoCalls('budgetAlerts', 'findOneAndUpdate')).toEqual([])
  })

  it('returns type, idleDays and the idle seats with names', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ type: 'idle-seat', idleDays: 14, limitHits: null })]
    mongoState.docs.seats = [{ _id: `${USER_B}:claude`, orgId: ORG_A, userId: USER_B, agent: 'claude', startDate: '2026-01-01' }]
    mongoState.docs.users = [{ _id: USER_B, name: 'Bo' }]
    mongoState.aggregates.dailySnapshots = [] // no active pairs, and no spend
    const [row] = (await app.inject({ method: 'GET', url: '/v1/dashboard/budget-alerts', headers: auth(token({ role: 'admin' })) })).json()
    expect(row).toMatchObject({
      type: 'idle-seat',
      idleDays: 14,
      limitHits: null,
      idleSeats: [{ userId: USER_B, userName: 'Bo', agent: 'claude' }],
    })
  })

  it('reports idleSeats null for an api-spend alert', async () => {
    mongoState.docs.budgetAlerts = [alertDoc()]
    spend(0)
    const [row] = (await app.inject({ method: 'GET', url: '/v1/dashboard/budget-alerts', headers: auth(token({ role: 'admin' })) })).json()
    expect(row).toMatchObject({ type: 'api-spend', idleSeats: null })
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

  it('touches the device after the transaction commits', async () => {
    liveDeviceToken()
    knownUser()
    await submit()

    const [touch] = mongoCalls('devices', 'updateOne') as [
      { _id: string },
      { $set: { lastSeenAt: unknown } },
    ][]
    expect(touch[0]).toEqual({ _id: DEVICE_A })
    expect(touch[1].$set.lastSeenAt).toBeInstanceOf(Date)
    // Last, after every write the transaction body issues, so a rolled-back
    // submission never advances it.
    expect(mongoState.calls.map((c) => `${c.collection}.${c.op}`).at(-1)).toBe('devices.updateOne')
  })

  it('records agent and highest Claude Code version on the device', async () => {
    liveDeviceToken()
    knownUser()
    await submit({
      ...payload,
      agentVersion: '0.4.0',
      enrichment: { ...enrichment, claudeVersions: { '2.1.99': 4, '2.1.330': 1, '2.0.5': 9 } },
    })
    const [[, update]] = mongoCalls('devices', 'updateOne') as [unknown, { $set: Record<string, unknown> }][]
    expect(update.$set).toMatchObject({ agentVersion: '0.4.0', claudeVersion: '2.1.330' })
  })

  it('leaves both versions alone for a 0.3 agent that sends neither', async () => {
    liveDeviceToken()
    knownUser()
    await submit({ ...payload, enrichment })
    const [[, update]] = mongoCalls('devices', 'updateOne') as [unknown, { $set: Record<string, unknown> }][]
    expect(Object.keys(update.$set)).toEqual(['lastSeenAt'])
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
  const body = { email: 'New@Example.com', name: 'New Dev' }

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
    expect(mongoCalls('users', 'insertOne')).toHaveLength(0)
  })

  it('creates a user in the admin own organization, with the email lowercased', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin/users',
      headers: auth(token({ role: 'admin' })),
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    const [[written]] = mongoCalls('users', 'insertOne') as [[Record<string, unknown>]]
    expect(res.json()).toEqual({ userId: written._id })
    expect(written).toMatchObject({ orgId: ORG_A, email: 'new@example.com', role: 'developer' })
    expect(written._id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns 409 on a duplicate email rather than leaking the constraint error', async () => {
    vi.spyOn(getStore().users, 'insertOne').mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key error collection: users index: users_email'), {
        code: 11000,
      }),
    )
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin/users',
      headers: auth(token({ role: 'admin' })),
      payload: body,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('A user with this email already exists')
    expect(res.payload).not.toContain('E11000')
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
    hostnames: ['laptop-1'],
    lastSeenAt: '2026-11-05T12:00:00Z',
    lastSyncDate: '2026-11-04',
    totalCostUsd: 12.5,
    totalTokens: 1000,
    activeDays: 3,
    ...over,
  })

  const pipeline = () => mongoCalls('users', 'aggregate')[0][0] as Record<string, Record<string, unknown>>[]

  it('returns 401 without a token', async () => {
    const res = await app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(401)
  })

  it.each(['developer', 'manager', 'device'] as const)('returns 403 for a %s token', async (role) => {
    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role })) })
    expect(res.statusCode).toBe(403)
    expect(mongoCalls('users', 'aggregate')).toHaveLength(0)
  })

  it('scopes the query to the caller own organization, before anything else', async () => {
    mongoState.aggregates.users = [row()]
    const res = await app.inject({
      method: 'GET',
      url,
      headers: auth(token({ role: 'admin', orgId: ORG_B })),
    })
    expect(res.statusCode).toBe(200)
    // The org filter is the only thing standing between one company's admin
    // and another company's roster. First stage, so no lookup runs on a user
    // from another org.
    expect(pipeline()[0]).toEqual({ $match: { orgId: ORG_B } })
  })

  it('joins devices and snapshots on the user, each grouped in its own lookup', async () => {
    await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })
    // The SQL version broke by correlating on the wrong table, which zeroed
    // every total. Here the join key is spelled out per lookup.
    const lookups = pipeline()
      .filter((s) => '$lookup' in s)
      .map((s) => s.$lookup as Record<string, unknown>)
    expect(lookups.map((l) => [l.from, l.localField, l.foreignField])).toEqual([
      ['devices', '_id', 'userId'],
      ['dailySnapshots', '_id', 'userId'],
    ])
  })

  it('hands back the roster rows unchanged, never an _id', async () => {
    mongoState.aggregates.users = [
      row({ deviceCount: 0, hostnames: [], lastSeenAt: null, lastSyncDate: null, totalCostUsd: 0, totalTokens: 0, activeDays: 0 }),
    ]
    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      row({ deviceCount: 0, hostnames: [], lastSeenAt: null, lastSyncDate: null, totalCostUsd: 0, totalTokens: 0, activeDays: 0 }),
    ])
    const project = pipeline().at(-1)!.$project as Record<string, unknown>
    expect(project._id).toBe(0)
    expect(project.id).toBe('$_id')
  })

  it('formats timestamps in the database, not through a local-time Date', async () => {
    await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })
    const project = pipeline().at(-1)!.$project as Record<string, Record<string, Record<string, unknown>>>
    expect(project.lastSeenAt.$dateToString.format).toBe('%Y-%m-%dT%H:%M:%SZ')
    // `date` is already a YYYY-MM-DD string, so the max of it is too.
    expect(project.lastSyncDate).toEqual({ $ifNull: ['$usage.lastSyncDate', null] })
  })

  it('ranks by spend, highest first', async () => {
    mongoState.aggregates.users = [
      row({ id: 'a', name: 'Low', totalCostUsd: 1 }),
      row({ id: 'b', name: 'High', totalCostUsd: 99 }),
    ]
    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })
    expect(res.json().map((u: { name: string }) => u.name)).toEqual(['High', 'Low'])
  })
})

describe('device registration', () => {
  const registration = {
    email: 'Dev@Example.com',
    hostname: 'laptop.local',
    platform: 'darwin',
    agentVersion: '0.1.0',
  }

  it('does not issue tokens at registration, only a pending code', async () => {
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A }]

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register-device',
      payload: registration,
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json).toHaveProperty('pendingId')
    expect(json).toHaveProperty('code')
    expect(json).not.toHaveProperty('accessToken')
    expect(json).not.toHaveProperty('refreshToken')

    const [[written]] = mongoCalls('pendingDevices', 'insertOne') as [[Record<string, unknown>]]
    expect(written._id).toBe(json.pendingId)
    expect(written).toMatchObject({ approvedAt: null, verifiedAt: null, deviceId: null })
    // Stored and looked up lowercase, the one casing every write uses.
    expect(written.email).toBe('dev@example.com')
    expect(mongoCalls('users', 'findOne')[0][0]).toEqual({ email: 'dev@example.com' })
  })

  it('returns 404 for an email that was never invited', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register-device',
      payload: { ...registration, email: 'stranger@example.com' },
    })
    expect(res.statusCode).toBe(404)
    expect(mongoCalls('pendingDevices', 'insertOne')).toHaveLength(0)
  })

  // BW-30. register-device hands the caller both halves of what verify-device
  // asks for, so before approval existed those two unauthenticated calls were a
  // complete path from "knows a colleague's work email" to a 30-day token.
  it('cannot be completed by the two unauthenticated calls alone', async () => {
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A }]

    const registered = await app.inject({
      method: 'POST',
      url: '/v1/auth/register-device',
      payload: registration,
    })
    const { pendingId, code } = registered.json()

    // Nothing approved the document, so the lookup matches nothing.
    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-device',
      payload: { pendingId, code },
    })

    expect(verified.statusCode).toBe(400)
    expect(verified.json()).not.toHaveProperty('accessToken')

    // The fake ignores filters, so an empty result only proves the route
    // handles a miss. What makes the sequence fail is the filter itself:
    // assert verify-device will not look at an unapproved document.
    expect(mongoCalls('pendingDevices', 'findOneAndUpdate')[0][0]).toMatchObject({
      _id: pendingId,
      code,
      approvedAt: { $ne: null },
      verifiedAt: null,
      expiresAt: { $gt: expect.any(Date) },
    })
  })

  it('rejects an unverifiable code without creating a device', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-device',
      payload: { pendingId: '66666666-6666-4666-8666-666666666666', code: 'ABC123' },
    })
    expect(res.statusCode).toBe(400)
    expect(mongoState.calls.some((c) => c.op === 'insertOne')).toBe(false)
  })

  it('stores a hash of the access token, never the token itself', async () => {
    mongoState.docs.pendingDevices = [
      { _id: 'pending-1', email: 'dev@example.com', hostname: 'laptop.local', platform: 'darwin', agentVersion: '0.1.0' },
    ]
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A }]

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-device',
      payload: { pendingId: '66666666-6666-4666-8666-666666666666', code: 'ABC123' },
    })

    expect(res.statusCode).toBe(200)
    const { accessToken, deviceId } = res.json()
    const [[stored]] = mongoCalls('deviceTokens', 'insertOne') as [[Record<string, unknown>]]

    expect(stored.tokenHash).toBeTypeOf('string')
    expect(stored.tokenHash).not.toBe(accessToken)
    expect(String(stored.tokenHash)).toHaveLength(64)
    expect(stored).toMatchObject({ deviceId, revokedAt: null })

    // The device, the pending claim and the token all name one new id.
    const [[device]] = mongoCalls('devices', 'insertOne') as [[Record<string, unknown>]]
    expect(device).toMatchObject({ _id: deviceId, userId: USER_A, hostname: 'laptop.local' })
    const [[, claim]] = mongoCalls('pendingDevices', 'findOneAndUpdate') as [
      [unknown, { $set: Record<string, unknown> }],
    ]
    expect(claim.$set).toMatchObject({ deviceId, verifiedAt: expect.any(Date) })
    expect(mongoCalls('pendingDevices', 'updateOne')).toHaveLength(0)
  })

  // Two polls on one approved code used to both pass a findOne on
  // verifiedAt: null before either wrote it, so each minted a device and a
  // 30-day token. The claim is now one findOneAndUpdate, and only the poll
  // whose update matched gets anything.
  it('mints one device when two polls race on the same approved code', async () => {
    mongoState.claimOnce = ['pendingDevices']
    mongoState.docs.pendingDevices = [
      { _id: 'pending-1', email: 'dev@example.com', hostname: 'laptop.local', platform: 'darwin', agentVersion: '0.1.0' },
    ]
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A }]
    const poll = () => app.inject({
      method: 'POST',
      url: '/v1/auth/verify-device',
      payload: { pendingId: '66666666-6666-4666-8666-666666666666', code: 'ABC123' },
    })

    const results = await Promise.all([poll(), poll()])

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400])
    expect(mongoCalls('devices', 'insertOne')).toHaveLength(1)
    expect(mongoCalls('deviceTokens', 'insertOne')).toHaveLength(1)
    // The single-winner behaviour above is the fake's; this is what buys it
    // from real MongoDB: the claim filters on the unverified, approved state.
    for (const [filter] of mongoCalls('pendingDevices', 'findOneAndUpdate')) {
      expect(filter).toMatchObject({ approvedAt: { $ne: null }, verifiedAt: null })
    }
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

  it('approves only a pending device carrying the signed-in user own email', async () => {
    mongoState.docs.users = [{ _id: USER_A, email: 'dev@example.com' }]
    mongoState.docs.pendingDevices = [{ hostname: 'laptop.local', platform: 'darwin' }]

    const res = await approve(auth(token()))

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hostname: 'laptop.local', platform: 'darwin' })

    expect(mongoCalls('users', 'findOne')[0][0]).toEqual({ _id: USER_A })
    const [[filter, update]] = mongoCalls('pendingDevices', 'findOneAndUpdate') as [
      [Record<string, unknown>, { $set: Record<string, unknown> }],
    ]
    // The email comes from the database document for the token's userId,
    // never from the request, so a caller cannot approve someone else's
    // pending device. One operation finds and claims, so two clicks cannot
    // both win.
    expect(filter).toMatchObject({
      code: 'ABC123',
      email: 'dev@example.com',
      approvedAt: null,
      verifiedAt: null,
      expiresAt: { $gt: expect.any(Date) },
    })
    expect(update.$set.approvedAt).toBeInstanceOf(Date)
  })

  it('answers an unknown, expired or already-claimed code identically', async () => {
    mongoState.docs.users = [{ _id: USER_A, email: 'dev@example.com' }]
    // No pending document: the claiming update matched nothing.

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
      mongoState.docs.users = [{ _id: USER_A }] // user lookup hits
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/admin/invites',
        headers: auth(adminToken()),
        payload: { email: 'Taken@Example.com' },
      })
      expect(res.statusCode).toBe(409)
      expect(mongoCalls('users', 'findOne')[0][0]).toEqual({ email: 'taken@example.com' })
      // Nothing was written.
      expect(mongoCalls('invites', 'insertOne')).toHaveLength(0)
    })

    it('stores only a hash, and scopes the invite to the admin own org', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/admin/invites',
        headers: auth(adminToken()),
        payload: { email: 'New@Example.com ' },
      })

      expect(res.statusCode).toBe(200)
      const { token: plaintext, inviteId } = res.json()
      const [[written]] = mongoCalls('invites', 'insertOne') as [[Record<string, unknown>]]

      expect(written.code).toBe(createHash('sha256').update(plaintext).digest('hex'))
      expect(written.code).not.toBe(plaintext)
      expect(written.orgId).toBe(ORG_A)
      // Email is normalised, so an invite cannot be duplicated by casing.
      expect(written.email).toBe('new@example.com')
      expect(written.role).toBe('developer')
      expect(written.usedAt).toBeNull()
      expect(written._id).toBe(inviteId)
    })

    it('defaults the invite to a 7 day expiry in the future', async () => {
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

  describe('POST /v1/auth/admin/invites/bulk', () => {
    const bulk = (rows: unknown[], role: 'admin' | 'developer' = 'admin') =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/admin/invites/bulk',
        headers: auth(token({ role })),
        payload: { rows },
      })

    it('returns 403 for a non-admin', async () => {
      expect((await bulk([{ email: 'a@example.com' }], 'developer')).statusCode).toBe(403)
    })

    it('rejects an empty upload and one over 200 rows', async () => {
      expect((await bulk([])).statusCode).toBe(400)
      const rows = Array.from({ length: 201 }, (_, i) => ({ email: `u${i}@example.com` }))
      expect((await bulk(rows)).statusCode).toBe(400)
    })

    it('invites good rows and reports each bad row without stopping', async () => {
      mongoState.docs.users = [{ _id: USER_A, email: 'taken@example.com' }]
      mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]

      const res = await bulk([
        { email: ' New@Example.com ', role: 'Manager', team: 'platform' },
        { email: 'plain@example.com' },
        { email: 'not-an-email' },
        { email: 'x@example.com', role: 'owner' },
        { email: 'y@example.com', team: 'Nope' },
        { email: 'TAKEN@example.com' },
        { email: 'new@example.com' },
      ])

      expect(res.statusCode).toBe(200)
      const { results } = res.json()
      expect(results.map((r: { ok: boolean; error?: string }) => r.error ?? 'ok')).toEqual([
        'ok',
        'ok',
        'Not a valid email',
        'Role must be admin, manager or developer',
        'No team named "Nope"',
        'A user with this email already exists',
        'Listed twice in this upload',
      ])
      expect(results[0]).toMatchObject({ email: 'new@example.com', role: 'manager' })
      expect(results[1]).toMatchObject({ email: 'plain@example.com', role: 'developer' })

      const written = mongoCalls('invites', 'insertOne').map(([doc]) => doc as Record<string, unknown>)
      expect(written).toHaveLength(2)
      expect(written[0]).toMatchObject({ orgId: ORG_A, teamId: TEAM_A, role: 'manager' })
      expect(written[0].code).toBe(createHash('sha256').update(results[0].token).digest('hex'))
      expect(written[1]).toMatchObject({ orgId: ORG_A, teamId: null })
      // Teams are read from the caller's org only.
      expect(mongoCalls('teams', 'find')[0][0]).toEqual({ orgId: ORG_A })
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

    it('never reads the stored hash, and scopes the list to the caller org', async () => {
      await app.inject({
        method: 'GET',
        url: '/v1/auth/admin/invites',
        headers: auth(token({ role: 'admin', orgId: ORG_B })),
      })
      const [[filter, opts]] = mongoCalls('invites', 'find') as [[unknown, Record<string, unknown>]]
      expect(filter).toEqual({ orgId: ORG_B })
      expect(opts).toEqual({ projection: { code: 0 }, sort: { createdAt: -1 }, limit: 200 })
    })

    it('answers with id, not _id, and leaves no hash in the body', async () => {
      const at = new Date('2026-11-01T10:00:00.000Z')
      // `code` is here as if the projection had failed; the route must not
      // pass it on either way.
      mongoState.docs.invites = [
        { _id: 'invite-1', orgId: ORG_A, email: 'a@b.c', role: 'developer', code: 'deadbeef', expiresAt: at, usedAt: null, createdAt: at },
      ]
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/admin/invites',
        headers: auth(adminToken()),
      })
      expect(res.json()).toEqual([
        {
          id: 'invite-1',
          email: 'a@b.c',
          role: 'developer',
          expiresAt: '2026-11-01T10:00:00.000Z',
          usedAt: null,
          createdAt: '2026-11-01T10:00:00.000Z',
        },
      ])
    })
  })

  describe('POST /v1/auth/invites/accept', () => {
    const accept = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/auth/invites/accept', payload })

    it('needs no authentication', async () => {
      const res = await accept({ token: 'whatever', name: 'New Dev' })
      expect(res.statusCode).not.toBe(401)
    })

    it('rejects an unknown, expired or already-used invite with one message', async () => {
      // The claim filters on unused and unexpired, so all three failures
      // arrive here as no document and must look identical.
      const res = await accept({ token: 'nope', name: 'New Dev' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('Invalid or expired invite')

      const [[filter, update]] = mongoCalls('invites', 'findOneAndUpdate') as [
        [Record<string, unknown>, { $set: Record<string, unknown> }],
      ]
      expect(filter).toEqual({
        code: createHash('sha256').update('nope').digest('hex'),
        usedAt: null,
        expiresAt: { $gt: expect.any(Date) },
      })
      expect(update.$set.usedAt).toBeInstanceOf(Date)
    })

    it('rejects a request with no name', async () => {
      const res = await accept({ token: 'abc' })
      expect(res.statusCode).toBe(400)
    })

    it('creates the user with the invite own org and role, not anything the caller sent', async () => {
      mongoState.docs.invites = [
        { _id: 'invite-1', orgId: ORG_B, email: 'invited@example.com', role: 'manager' },
      ]

      const res = await accept({ token: 'good-token', name: '  New Dev  ', orgId: ORG_A, role: 'admin' })

      expect(res.statusCode).toBe(200)
      const [[written]] = mongoCalls('users', 'insertOne') as [[Record<string, unknown>]]
      expect(res.json()).toEqual({
        userId: written._id,
        orgId: ORG_B,
        email: 'invited@example.com',
        role: 'manager',
      })
      expect(written.orgId).toBe(ORG_B)
      expect(written.role).toBe('manager')
      expect(written.name).toBe('New Dev')
    })

    it('claims the invite before creating the user, both inside one transaction', async () => {
      mongoState.docs.invites = [{ _id: 'invite-1', orgId: ORG_A, email: 'a@b.c', role: 'developer' }]

      await accept({ token: 'good-token', name: 'New Dev' })

      const ops = mongoState.calls.map((c) => `${c.collection}.${c.op}`)
      expect(ops).toEqual(['.transaction', 'invites.findOneAndUpdate', 'users.insertOne'])
    })

    it('adds the new user to the invite team, as manager for a manager invite', async () => {
      mongoState.docs.invites = [
        { _id: 'invite-1', orgId: ORG_A, email: 'a@b.c', role: 'manager', teamId: TEAM_A },
      ]
      mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]

      const res = await accept({ token: 'good-token', name: 'New Dev' })

      expect(res.statusCode).toBe(200)
      expect(mongoCalls('teams', 'findOne')[0][0]).toEqual({ _id: TEAM_A, orgId: ORG_A })
      const [[member]] = mongoCalls('teamMembers', 'insertOne') as [[Record<string, unknown>]]
      expect(member).toMatchObject({ teamId: TEAM_A, orgId: ORG_A, userId: res.json().userId, role: 'manager' })
    })

    it('skips the team when it was deleted after the invite was made', async () => {
      mongoState.docs.invites = [
        { _id: 'invite-1', orgId: ORG_A, email: 'a@b.c', role: 'developer', teamId: TEAM_A },
      ]

      const res = await accept({ token: 'good-token', name: 'New Dev' })

      expect(res.statusCode).toBe(200)
      expect(mongoCalls('teamMembers', 'insertOne')).toHaveLength(0)
    })

    it('cannot be replayed: the losing racer gets 400 and creates no user', async () => {
      // Both racers send the same claim; only one can match a still-null
      // usedAt, and the other gets no document back.
      const res = await accept({ token: 'good-token', name: 'New Dev' })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('Invalid or expired invite')
      expect(mongoCalls('users', 'insertOne')).toHaveLength(0)
    })

    it('rolls the claim back when the user cannot be created', async () => {
      // A user with the invited email already exists. The invite must not be
      // spent by a request that created nobody.
      mongoState.docs.invites = [{ _id: 'invite-1', orgId: ORG_A, email: 'a@b.c', role: 'developer' }]
      mongoState.failOn = 'users.insertOne'

      const res = await accept({ token: 'good-token', name: 'New Dev' })

      expect(res.statusCode).toBe(500)
      expect(mongoState.calls.map((c) => c.op)).toContain('rollback')
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

  it('refuses a device whose token has been revoked', async () => {
    // Nothing seeded: no unrevoked token for this device.
    const res = await submit()

    expect(res.statusCode).toBe(401)
    // The fake ignores filters, so an empty result only shows the guard
    // handles a miss. What makes a revoked laptop fail is the filter itself,
    // so assert the lookup asks for a token that is still unrevoked.
    expect(guardFilter()).toEqual({ deviceId: DEVICE_A, revokedAt: null })
    expect(mongoState.calls.some((c) => c.op === 'transaction')).toBe(false)
  })

  it('refuses a device that has no token at all', async () => {
    const res = await submit()

    expect(res.statusCode).toBe(401)
    // Scoped to the device the token names, so another laptop's live token
    // cannot authorise this one.
    expect(guardFilter()?.deviceId).toBe(DEVICE_A)
  })

  it('fails closed with 401 when the token lookup itself fails', async () => {
    // A database outage must not wave a device through, and must not surface
    // as a 500 from the global handler either.
    liveDeviceToken()
    mongoState.failOn = 'deviceTokens.findOne'

    const res = await submit()

    expect(res.statusCode).toBe(401)
    expect(mongoState.calls.some((c) => c.op === 'transaction')).toBe(false)
  })

  it('lets a device with a live token through', async () => {
    liveDeviceToken()
    // The rebuild reads the user to learn the org and aborts the transaction
    // when it is absent, so a submission that is meant to reach 200 needs one.
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A }]

    const res = await submit()

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ accepted: 1, skipped: 0, date: DATE })
    // One read, not two: this is the whole cost the guard adds to every
    // usage submission, and it should stay one operation.
    expect(deviceTokenReads()).toHaveLength(1)
  })

  it('still authorises a device whose token is past expiresAt but not revoked', async () => {
    // Looks wrong until you follow the refresh path. `expiresAt` is written
    // once at registration as now + 30 days and never updated, while
    // /v1/auth/refresh mints a fresh 30-day access token without inserting a
    // new document. An `expiresAt > now` term here would 401 every
    // legitimately refreshing device on day 31. Expiry is the JWT `exp`
    // claim's job, and accessJwtVerify has already checked it by the time
    // this runs.
    liveDeviceToken()
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A }]

    const res = await submit()

    expect(res.statusCode).toBe(200)
    expect(deviceTokenReads()).toHaveLength(1)
    expect(guardFilter()).not.toHaveProperty('expiresAt')
  })

  it('never reads deviceTokens for a dashboard role, which has none', async () => {
    // Nothing is seeded, so an unconditional lookup would find nothing and
    // 401 every dashboard request. Dashboard users come through the same
    // accessJwtVerify and have no deviceTokens document at all.
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
    expect(guardFilter()).toEqual({ deviceId: DEVICE_A, revokedAt: null })
  })
})

describe('POST /v1/auth/admin/devices/revoke', () => {
  const url = '/v1/auth/admin/devices/revoke'
  const body = { deviceId: DEVICE_A }

  const revoke = (headers?: Record<string, string>, payload: Record<string, string> = body) =>
    app.inject({ method: 'POST', url, headers, payload })

  /** The device exists and hangs off a user in the caller's org. */
  const ownedDevice = () => {
    mongoState.docs.devices = [{ _id: DEVICE_A, userId: USER_A }]
    mongoState.docs.users = [{ _id: USER_A }]
  }

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

  it('revokes every live token for the device', async () => {
    ownedDevice()
    mongoState.docs.deviceTokens = [{ _id: 'token-1' }, { _id: 'token-2' }]

    const res = await revoke(auth(token({ role: 'admin' })))

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ deviceId: DEVICE_A, revoked: 2 })
    // updateMany and scoped to tokens that are still live, so one call ends
    // every token the laptop holds and a second call is a no-op rather than a
    // lie about how many it just ended.
    const [[filter, update]] = mongoCalls('deviceTokens', 'updateMany') as [
      [unknown, { $set: Record<string, unknown> }],
    ]
    expect(filter).toEqual({ deviceId: DEVICE_A, revokedAt: null })
    expect(update.$set.revokedAt).toBeInstanceOf(Date)
  })

  it('reports zero rather than failing when the device holds no live token', async () => {
    ownedDevice()

    const res = await revoke(auth(token({ role: 'admin' })))

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ deviceId: DEVICE_A, revoked: 0 })
  })

  it('refuses a device in another organization and writes nothing', async () => {
    // The device exists, but the org-scoped owner lookup matches nothing.
    mongoState.docs.devices = [{ _id: DEVICE_A, userId: USER_A }]

    const res = await revoke(auth(token({ role: 'admin', orgId: ORG_B })))

    expect(res.statusCode).toBe(404)
    expect(mongoCalls('deviceTokens', 'updateMany')).toHaveLength(0)
    // The lookup is the whole control: the device has to hang off a user in
    // the caller's own org before anything is written.
    expect(mongoCalls('users', 'findOne')[0][0]).toEqual({ _id: USER_A, orgId: ORG_B })
  })

  it('answers an unknown device the same way as another org device', async () => {
    const res = await revoke(auth(token({ role: 'admin' })))

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('Device not found')
    expect(mongoCalls('deviceTokens', 'updateMany')).toHaveLength(0)
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
    // serve it: a device token is not an admin token. The one seeded token
    // serves requireAuth's own guard and is then the one revoked.
    liveDeviceToken()

    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth(token({ role: 'device', deviceId: DEVICE_A })),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ deviceId: DEVICE_A, revoked: 1 })
    expect(mongoCalls('deviceTokens', 'updateMany')[0][0]).toEqual({
      deviceId: DEVICE_A,
      revokedAt: null,
    })
  })
})

describe('GET /v1/auth/admin/devices', () => {
  const url = '/v1/auth/admin/devices'
  const pipeline = () => mongoCalls('users', 'aggregate')[0][0] as Record<string, Record<string, unknown>>[]

  const device = {
    id: DEVICE_A,
    hostname: 'laptop-1',
    platform: 'darwin',
    lastSeenAt: '2026-11-05T12:00:00Z',
    userName: 'Dev One',
    userEmail: 'dev1@example.com',
    revoked: false,
  }

  it.each(['developer', 'manager', 'device'] as const)('returns 403 for a %s token', async (role) => {
    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role })) })
    expect(res.statusCode).toBe(403)
  })

  it('lists only devices in the caller own organization', async () => {
    mongoState.aggregates.users = [device]

    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin', orgId: ORG_B })) })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([device])
    expect(pipeline()[0]).toEqual({ $match: { orgId: ORG_B } })
  })

  it('takes the org from the token and ignores one supplied in the query', async () => {
    // A read that leaks the fleet is a smaller hole than a write, not a
    // non-hole: this route hands back every hostname and owner email in an
    // org, so the filter has to come from the JWT and nowhere else.
    const res = await app.inject({
      method: 'GET',
      url: `${url}?orgId=${ORG_B}`,
      headers: auth(token({ role: 'admin', orgId: ORG_A })),
    })

    expect(res.statusCode).toBe(200)
    const queried = inspect(mongoState.calls, { depth: null })
    expect(queried).toContain(ORG_A)
    expect(queried).not.toContain(ORG_B)
  })

  it('derives revoked from the absence of an unrevoked token', async () => {
    await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })

    const lookup = pipeline().find(
      (s) => '$lookup' in s && (s.$lookup as Record<string, unknown>).from === 'deviceTokens',
    )!.$lookup as Record<string, unknown>
    expect(lookup).toMatchObject({ localField: 'device._id', foreignField: 'deviceId' })
    expect(lookup.pipeline).toContainEqual({ $match: { revokedAt: null } })
    const project = pipeline().at(-1)!.$project as Record<string, unknown>
    expect(project.revoked).toEqual({ $eq: [{ $size: '$live' }, 0] })
    expect(project._id).toBe(0)
  })
})

describe('GET /health', () => {
  // The value is never dialled — @burn-watch/db is mocked wholesale. Every
  // case below except the last is about what happens once Mongo IS
  // configured.
  beforeEach(() => {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/burnwatch_test'
  })

  afterEach(() => {
    delete process.env.MONGODB_URI
  })

  it('needs no authentication and returns 200 when the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('returns 503 naming mongo when the MongoDB ping fails', async () => {
    mongoState.pingFails = true
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ok: false, failed: ['mongo'] })
    // The driver error carries the host it failed to reach.
    expect(res.payload).not.toContain('mongo.example')
  })

  /**
   * BW-37's shape on a database that will not raise it for us. A missing
   * usageEvents_key unique index fails no query at all, it only stops the
   * two-tier upsert deduplicating, so a check that does not read the live
   * index list would answer 200 while every re-sync inserted duplicates.
   */
  it('returns 503 naming mongoSchema when the MongoDB shape has drifted', async () => {
    mongoState.schemaFails = true
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ok: false, failed: ['mongoSchema'] })
    // The drift text names collections and indexes, and goes to the log only.
    expect(res.payload).not.toContain('usageEvents_key')
  })

  it('names every failed dependency rather than the first', async () => {
    mongoState.pingFails = true
    mongoState.schemaFails = true
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toEqual({ ok: false, failed: ['mongo', 'mongoSchema'] })
  })

  /**
   * Every handler calls getStore(), which throws outright when the variable
   * is unset. The branch preview once answered 200 {"ok":true} here while
   * all five dashboard routes answered 500, because the checks were skipped
   * when the variable was missing.
   *
   * Both mocks are left healthy, so the only thing that can fail this case is
   * the missing variable itself.
   */
  it('reports mongo down when MONGODB_URI is unset, because handlers need it', async () => {
    delete process.env.MONGODB_URI

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
    // What a driver failure looks like: collection or table names at least,
    // and sometimes values.
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

describe('GET /v1/dashboard/governance/free-tier', () => {
  const URL = range('/v1/dashboard/governance/free-tier')
  const get = (role: JwtPayload['role'], url = URL) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  const match = () =>
    (callsTo(mongoState, 'usageEvents', 'aggregate')[0][0] as Document[])[0].$match as Record<string, unknown>

  const seedGroups = () => {
    mongoState.aggregates.usageEvents = [
      {
        _id: { userId: USER_A, agent: 'qwen', modelName: 'coder-model' },
        days: 3,
        tokens: 900,
        firstDate: '2026-11-01',
        lastDate: '2026-11-05',
      },
      {
        _id: { userId: USER_B, agent: 'claude', modelName: 'claude-new' },
        days: 1,
        tokens: 100,
        firstDate: '2026-11-05',
        lastDate: '2026-11-05',
      },
    ]
    mongoState.docs.users = [
      { _id: USER_A, orgId: ORG_A, name: 'Ada', email: 'ada@x.test' },
      { _id: USER_B, orgId: ORG_A, name: 'Bo', email: 'bo@x.test' },
    ]
  }

  it('refuses a developer before reading usage', async () => {
    seedGroups()
    expect((await get('developer')).statusCode).toBe(403)
    expect(callsTo(mongoState, 'usageEvents', 'aggregate')).toEqual([])
  })

  it('requires a full range', async () => {
    expect((await get('admin', '/v1/dashboard/governance/free-tier')).statusCode).toBe(400)
  })

  it('reads only free-tier rows in the caller org and range, org-wide for an admin', async () => {
    expect((await get('admin')).json()).toEqual({ rows: [], byTeam: [] })
    expect(match()).toEqual({ orgId: ORG_A, isFreeTier: true, date: { $gte: DATE, $lte: DATE } })
    // Nothing to name, so no user or team reads.
    expect(callsTo(mongoState, 'users', 'find')).toEqual([])
  })

  it('says why each row was flagged and totals per team, with a no-team bucket', async () => {
    seedGroups()
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [{ teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' }]
    const res = await get('admin')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.rows).toEqual([
      {
        userId: USER_A,
        userName: 'Ada',
        userEmail: 'ada@x.test',
        teams: ['Platform'],
        agent: 'qwen',
        modelName: 'coder-model',
        reason: 'free-tier-agent',
        days: 3,
        tokens: 900,
        firstDate: '2026-11-01',
        lastDate: '2026-11-05',
      },
      expect.objectContaining({ userId: USER_B, teams: [], reason: 'unpriced-model', tokens: 100 }),
    ])
    expect(body.byTeam).toEqual([
      { teamId: TEAM_A, teamName: 'Platform', users: 1, tokens: 900 },
      { teamId: null, teamName: null, users: 1, tokens: 100 },
    ])
    expect(callsTo(mongoState, 'users', 'find')[0][0]).toMatchObject({ orgId: ORG_A })
  })

  it('limits a manager to themselves and the teams they manage', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
    expect((await get('manager')).statusCode).toBe(200)
    expect(match().userId).toEqual({ $in: [USER_A, USER_B] })
  })

  it('answers 403 to a manager filtering a team they do not manage', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [{ teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'manager' }]
    const res = await get('manager', `${URL}&teamId=${TEAM_A}`)
    expect(res.statusCode).toBe(403)
    expect(callsTo(mongoState, 'usageEvents', 'aggregate')).toEqual([])
  })
})

describe('GET /v1/dashboard/governance/mcp', () => {
  const URL = range('/v1/dashboard/governance/mcp')
  const get = (role: JwtPayload['role'], url = URL) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  const match = () =>
    (callsTo(mongoState, 'claudeEnrichment', 'aggregate')[0][0] as Document[])[0].$match as Record<string, unknown>

  const seed = () => {
    mongoState.aggregates.claudeEnrichment = [
      { _id: 'playwright', calls: 40, users: [USER_B, USER_A], days: 2, lastDate: '2026-11-05' },
      { _id: 'plugin_vercel_vercel', calls: 9, users: [USER_A], days: 1, lastDate: '2026-11-04' },
      { _id: 'claude_ai_Neon', calls: 3, users: [USER_A], days: 1, lastDate: '2026-11-03' },
      { _id: '1a59c906-04da-521d-bda7-7f71b9f9e01c', calls: 1, users: [USER_A], days: 1, lastDate: '2026-11-02' },
    ]
    mongoState.docs.users = [
      { _id: USER_A, orgId: ORG_A, name: 'Ada' },
      { _id: USER_B, orgId: ORG_A, name: 'Bo' },
    ]
    mongoState.docs.mcpApprovals = [
      { _id: `${ORG_A}:playwright`, orgId: ORG_A, server: 'playwright', note: 'browser tests' },
      { _id: `${ORG_A}:context7`, orgId: ORG_A, server: 'context7', note: null },
    ]
  }

  it('refuses a developer before reading anything', async () => {
    seed()
    expect((await get('developer')).statusCode).toBe(403)
    expect(mongoState.calls).toEqual([])
  })

  it('requires a full range', async () => {
    expect((await get('admin', '/v1/dashboard/governance/mcp')).statusCode).toBe(400)
  })

  it('lists servers with source, approval and names, plus approvals nobody used', async () => {
    seed()
    const res = await get('admin')
    expect(res.statusCode).toBe(200)
    expect(match()).toEqual({ orgId: ORG_A, date: { $gte: DATE, $lte: DATE } })
    expect(callsTo(mongoState, 'mcpApprovals', 'find')[0][0]).toEqual({ orgId: ORG_A })
    expect(callsTo(mongoState, 'users', 'find')[0][0]).toMatchObject({ orgId: ORG_A })
    const body = res.json()
    expect(body.servers[0]).toEqual({
      server: 'playwright',
      source: 'local',
      approved: true,
      note: 'browser tests',
      users: [
        { userId: USER_A, name: 'Ada' },
        { userId: USER_B, name: 'Bo' },
      ],
      calls: 40,
      days: 2,
      lastDate: '2026-11-05',
    })
    expect(body.servers.map((s: { source: string; approved: boolean }) => [s.source, s.approved])).toEqual([
      ['local', true],
      ['plugin', false],
      ['claude.ai', false],
      ['unnamed', false],
    ])
    expect(body.unusedApprovals).toEqual([{ server: 'context7', note: null }])
  })

  it('limits a manager to themselves and the teams they manage', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
    expect((await get('manager')).statusCode).toBe(200)
    expect(match().userId).toEqual({ $in: [USER_A, USER_B] })
  })
})

describe('MCP approval routes', () => {
  const base = '/v1/dashboard/governance/mcp-approvals'
  const one = `${base}?server=${encodeURIComponent('claude_ai_Neon')}`
  const send = (method: 'PUT' | 'DELETE', url: string, payload?: object, role: JwtPayload['role'] = 'admin') =>
    app.inject({ method, url, payload, headers: auth(token({ role })) })

  it.each(['developer', 'manager'] as const)('answers 403 to a %s and writes nothing', async (role) => {
    expect((await send('PUT', base, { server: 'claude_ai_Neon', note: 'x' }, role)).statusCode).toBe(403)
    expect((await send('DELETE', one, undefined, role)).statusCode).toBe(403)
    expect(mongoState.calls).toEqual([])
  })

  it('upserts an org-scoped approval keyed on the exact server name', async () => {
    const res = await send('PUT', base, { server: 'claude_ai_Neon', note: '  Neon connector  ' })
    expect(res.statusCode).toBe(200)
    const [filter, update, options] = callsTo(mongoState, 'mcpApprovals', 'updateOne')[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown>; $setOnInsert: Record<string, unknown> },
      unknown,
    ]
    expect(filter).toEqual({ _id: `${ORG_A}:claude_ai_Neon` })
    expect(update.$set).toMatchObject({ note: 'Neon connector', approvedBy: USER_A })
    expect(update.$setOnInsert).toEqual({ orgId: ORG_A, server: 'claude_ai_Neon' })
    expect(options).toEqual({ upsert: true })
  })

  it('stores no note as null', async () => {
    await send('PUT', base, { server: 'claude_ai_Neon' })
    const update = callsTo(mongoState, 'mcpApprovals', 'updateOne')[0][1] as { $set: { note: unknown } }
    expect(update.$set.note).toBeNull()
  })

  it('accepts a 200-character key with a slash and rejects 201 characters', async () => {
    const long = `a/${'b'.repeat(198)}`
    expect((await send('PUT', base, { server: long })).statusCode).toBe(200)
    expect((await send('PUT', base, { server: `${long}c` })).statusCode).toBe(400)
    expect((await send('DELETE', `${base}?server=${'a'.repeat(201)}`)).statusCode).toBe(400)
    expect(callsTo(mongoState, 'mcpApprovals', 'updateOne')).toHaveLength(1)
    expect(callsTo(mongoState, 'mcpApprovals', 'deleteOne')).toEqual([])
  })

  it('revokes inside the caller org and answers 404 when nothing matched', async () => {
    expect((await send('DELETE', one)).statusCode).toBe(404)
    expect(callsTo(mongoState, 'mcpApprovals', 'deleteOne')[0][0]).toEqual({
      _id: `${ORG_A}:claude_ai_Neon`,
      orgId: ORG_A,
    })
    mongoState.docs.mcpApprovals = [{ _id: `${ORG_A}:claude_ai_Neon` }]
    expect((await send('DELETE', one)).json()).toEqual({ server: 'claude_ai_Neon', approved: false })
  })
})

describe('GET /v1/dashboard/governance/violations', () => {
  const URL = range('/v1/dashboard/governance/violations')
  const get = (role: JwtPayload['role'], url = URL) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  const aggregates = () => callsTo(mongoState, 'usageEvents', 'aggregate').map((c) => c[0] as Document[])
  const policy = (agent: string, rule: string, models: string[] = []) => ({
    _id: `${ORG_A}:${agent}`,
    orgId: ORG_A,
    agent,
    rule,
    models,
    note: null,
  })

  it('refuses a developer before reading anything', async () => {
    expect((await get('developer')).statusCode).toBe(403)
    expect(mongoState.calls).toEqual([])
  })

  it('flags every agent with no rule, and lists all five as unset', async () => {
    const body = (await get('admin')).json()
    expect(body.policies.map((p: { agent: string; rule: string }) => `${p.agent}:${p.rule}`)).toEqual([
      'claude:unset',
      'qwen:unset',
      'gemini:unset',
      'codex:unset',
      'copilot:unset',
    ])
    expect(callsTo(mongoState, 'agentPolicies', 'find')[0][0]).toEqual({ orgId: ORG_A })
    expect(aggregates()[0][0].$match).toEqual({
      orgId: ORG_A,
      date: { $gte: DATE, $lte: DATE },
      $or: [{ agent: { $in: ['claude', 'qwen', 'gemini', 'codex', 'copilot'] } }],
    })
  })

  it('matches unlisted models by exact name and skips allowed agents', async () => {
    mongoState.docs.agentPolicies = [
      policy('claude', 'models', ['claude-opus-5']),
      policy('qwen', 'blocked'),
      policy('gemini', 'allowed'),
      policy('codex', 'allowed'),
      policy('copilot', 'allowed'),
    ]
    await get('admin')
    expect(aggregates()[0][0].$match.$or).toEqual([
      { agent: { $in: ['qwen'] } },
      { agent: 'claude', modelName: { $nin: ['claude-opus-5'] } },
    ])
  })

  it('runs no violation query when every agent is allowed', async () => {
    mongoState.docs.agentPolicies = ['claude', 'qwen', 'gemini', 'codex', 'copilot'].map((a) => policy(a, 'allowed'))
    mongoState.aggregates.usageEvents = [{ _id: 'claude', models: ['claude-opus-5'] }]
    const body = (await get('admin')).json()
    expect(body.rows).toEqual([])
    // Only the seen-models read.
    expect(aggregates()).toHaveLength(1)
    expect(aggregates()[0][0].$match.$or).toBeUndefined()
  })

  it('names each row and says why it was flagged', async () => {
    mongoState.docs.agentPolicies = [policy('claude', 'models', ['claude-opus-5']), policy('qwen', 'blocked')]
    mongoState.aggregates.usageEvents = [
      { _id: { userId: USER_A, agent: 'claude', modelName: 'claude-opus-5-5' }, days: 2, tokens: 50, firstDate: DATE, lastDate: DATE },
      { _id: { userId: USER_A, agent: 'qwen', modelName: 'coder-model' }, days: 1, tokens: 10, firstDate: DATE, lastDate: DATE },
      { _id: { userId: USER_B, agent: 'gemini', modelName: 'gemini-3' }, days: 1, tokens: 5, firstDate: DATE, lastDate: DATE },
    ]
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A, name: 'Ada', email: 'ada@x.test' }]
    // A manager, because the fake answers every usageEvents aggregate with the
    // same seed and an admin also runs the seen-models read.
    const body = (await get('manager')).json()
    expect(body.rows.map((r: { modelName: string; reason: string }) => [r.modelName, r.reason])).toEqual([
      ['claude-opus-5-5', 'model-not-listed'],
      ['coder-model', 'agent-blocked'],
      ['gemini-3', 'agent-not-set'],
    ])
    expect(body.rows[0]).toMatchObject({ userName: 'Ada', userEmail: 'ada@x.test', teams: [] })
    expect(body.policies[0]).toEqual({ agent: 'claude', rule: 'models', models: ['claude-opus-5'], note: null })
  })

  it('limits a manager to their teams and skips the seen-models read', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
    const body = (await get('manager')).json()
    expect(aggregates()).toHaveLength(1)
    expect(aggregates()[0][0].$match.userId).toEqual({ $in: [USER_A, USER_B] })
    expect(body.seenModels).toEqual({})
  })
})

describe('agent policy routes', () => {
  const send = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: object, role: JwtPayload['role'] = 'admin') =>
    app.inject({ method, url, payload, headers: auth(token({ role })) })
  const one = '/v1/dashboard/governance/agent-policy/claude'

  it.each(['developer', 'manager'] as const)('answers 403 to a %s and touches nothing', async (role) => {
    expect((await send('PUT', one, { rule: 'allowed' }, role)).statusCode).toBe(403)
    expect((await send('DELETE', one, undefined, role)).statusCode).toBe(403)
    expect((await send('GET', '/v1/dashboard/governance/violations/count', undefined, role)).statusCode).toBe(403)
    expect(mongoState.calls).toEqual([])
  })

  it('upserts an org-scoped rule with de-duplicated exact models', async () => {
    const res = await send('PUT', one, { rule: 'models', models: ['claude-opus-5', ' claude-opus-5 '], note: ' ok ' })
    expect(res.statusCode).toBe(200)
    const [filter, update, options] = callsTo(mongoState, 'agentPolicies', 'updateOne')[0] as [
      unknown,
      { $set: Record<string, unknown>; $setOnInsert: unknown },
      unknown,
    ]
    expect(filter).toEqual({ _id: `${ORG_A}:claude` })
    expect(update.$set).toMatchObject({ rule: 'models', models: ['claude-opus-5'], note: 'ok', updatedBy: USER_A })
    expect(update.$setOnInsert).toEqual({ orgId: ORG_A, agent: 'claude' })
    expect(options).toEqual({ upsert: true })
  })

  it('drops models when the rule is not models-only', async () => {
    await send('PUT', one, { rule: 'blocked', models: ['x'] })
    const update = callsTo(mongoState, 'agentPolicies', 'updateOne')[0][1] as { $set: { models: unknown } }
    expect(update.$set.models).toEqual([])
  })

  it.each([
    ['an unknown agent', '/v1/dashboard/governance/agent-policy/cursor', { rule: 'allowed' }],
    ['models-only with no models', one, { rule: 'models', models: [] }],
    ['over 50 models', one, { rule: 'models', models: Array.from({ length: 51 }, (_, i) => `m${i}`) }],
    ['an unknown rule', one, { rule: 'maybe' }],
  ])('rejects %s with 400', async (_label, url, payload) => {
    expect((await send('PUT', url, payload)).statusCode).toBe(400)
    expect(callsTo(mongoState, 'agentPolicies', 'updateOne')).toEqual([])
  })

  it('resets to unset inside the caller org, 404 when there was no rule', async () => {
    expect((await send('DELETE', one)).statusCode).toBe(404)
    expect(callsTo(mongoState, 'agentPolicies', 'deleteOne')[0][0]).toEqual({ _id: `${ORG_A}:claude`, orgId: ORG_A })
  })

  it('counts violation groups over the last 30 days for an admin', async () => {
    mongoState.aggregates.usageEvents = [{ n: 4 }]
    expect((await send('GET', '/v1/dashboard/governance/violations/count')).json()).toEqual({ count: 4 })
    const pipeline = callsTo(mongoState, 'usageEvents', 'aggregate')[0][0] as Document[]
    expect(pipeline[0].$match).toMatchObject({ orgId: ORG_A, $or: [{ agent: { $in: expect.any(Array) } }] })
    expect(pipeline.at(-1)).toEqual({ $count: 'n' })
  })
})

describe('GET /v1/dashboard/adoption/idle-seats', () => {
  const URL = '/v1/dashboard/adoption/idle-seats'
  const USER_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const get = (role: JwtPayload['role'], url = URL) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  const t = today()
  const seatDoc = (userId: string, agent: string, startDate: string, usd: number) => ({
    _id: `${userId}:${agent}`,
    orgId: ORG_A,
    userId,
    agent,
    monthlyPriceMicros: usd * 1e6,
    startDate,
  })

  const seed = () => {
    mongoState.docs.seats = [
      seatDoc(USER_A, 'claude', daysBefore(t, 100), 30),
      seatDoc(USER_B, 'copilot', daysBefore(t, 40), 19), // never used
    ]
    // Both the idle check and seatLastUsed read this. A pair-keyed row never
    // matches a seat key, so both seats stay idle and USER_A has a last use.
    mongoState.aggregates.dailySnapshots = [{ _id: { userId: USER_A, agent: 'claude' }, lastUsed: daysBefore(t, 20) }]
    mongoState.docs.users = [
      { _id: USER_A, orgId: ORG_A, name: 'Ada' },
      { _id: USER_B, orgId: ORG_A, name: 'Bo' },
    ]
  }

  it('refuses a developer before reading seats', async () => {
    seed()
    expect((await get('developer')).statusCode).toBe(403)
    expect(callsTo(mongoState, 'seats', 'find')).toEqual([])
  })

  it.each(['0', '366', '1.5', 'abc'])('rejects idleDays=%s', async (n) => {
    expect((await get('admin', `${URL}?idleDays=${n}`)).statusCode).toBe(400)
    expect(callsTo(mongoState, 'seats', 'find')).toEqual([])
  })

  it('reads only the caller org, skips seats younger than the window, defaults to 14 days', async () => {
    const res = await get('admin')
    expect(res.json()).toEqual({ idleDays: 14, rows: [], byAgent: [], byTeam: [], totalMonthlyUsd: 0, orgSeats: 0 })
    expect(callsTo(mongoState, 'seats', 'find')[0][0]).toEqual({ orgId: ORG_A, startDate: { $lte: daysBefore(t, 13) } })
    expect(callsTo(mongoState, 'seats', 'find')[1][0]).toEqual({ orgId: ORG_A })
    // Nothing idle, so no last-used, user or team reads.
    expect(callsTo(mongoState, 'dailySnapshots', 'aggregate')).toEqual([])
    expect(callsTo(mongoState, 'users', 'find')).toEqual([])
  })

  it('lists idle seats longest idle first, counting a never-used seat from its start date', async () => {
    seed()
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [{ teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' }]
    const { seatCost } = await import('@burn-watch/db')
    const res = await get('admin', `${URL}?idleDays=30`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(callsTo(mongoState, 'seats', 'find')[0][0]).toMatchObject({ startDate: { $lte: daysBefore(t, 29) } })
    const [, lastUsedPipeline] = callsTo(mongoState, 'dailySnapshots', 'aggregate') as Document[][][]
    expect(lastUsedPipeline[0][0].$match).toEqual({ orgId: ORG_A, userId: { $in: [USER_A, USER_B] } })
    expect(callsTo(mongoState, 'users', 'find')[0][0]).toMatchObject({ orgId: ORG_A })

    const [bo, ada] = mongoState.docs.seats.slice().reverse() as Parameters<typeof seatCost>[0][]
    expect(body.rows).toEqual([
      {
        userId: USER_B,
        userName: 'Bo',
        teams: [],
        agent: 'copilot',
        startDate: daysBefore(t, 40),
        lastUsed: null,
        daysIdle: 41,
        monthlyPriceUsd: 19,
        costSinceUsedUsd: seatCost(bo, daysBefore(t, 40), t, t) / 1e6,
      },
      {
        userId: USER_A,
        userName: 'Ada',
        teams: ['Platform'],
        agent: 'claude',
        startDate: daysBefore(t, 100),
        lastUsed: daysBefore(t, 20),
        daysIdle: 20,
        monthlyPriceUsd: 30,
        costSinceUsedUsd: seatCost(ada, daysBefore(t, 19), t, t) / 1e6,
      },
    ])
    expect(body.byAgent).toEqual([
      { agent: 'claude', seats: 1, monthlyUsd: 30 },
      { agent: 'copilot', seats: 1, monthlyUsd: 19 },
    ])
    expect(body.byTeam).toEqual([{ teamId: TEAM_A, teamName: 'Platform', seats: 1, monthlyUsd: 30 }])
    expect(body.totalMonthlyUsd).toBe(49)
    expect(body.orgSeats).toBe(2)
  })

  it('limits a manager to their teams, and hides the org seat count', async () => {
    seed()
    mongoState.docs.seats.push(seatDoc(USER_C, 'gemini', daysBefore(t, 60), 20))
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
    const body = (await get('manager')).json()
    expect(body.rows.map((r: { userId: string }) => r.userId).sort()).toEqual([USER_A, USER_B].sort())
    expect(body.orgSeats).toBeNull()
    expect(body.totalMonthlyUsd).toBe(49)
    // Only the idle check reads seats; no org-wide count for a manager.
    expect(callsTo(mongoState, 'seats', 'find')).toHaveLength(1)
  })

  it('answers 404 to a team outside the org and 403 to a team a manager does not run', async () => {
    seed()
    expect((await get('admin', `${URL}?teamId=${TEAM_B}`)).statusCode).toBe(404)
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [{ teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'manager' }]
    expect((await get('manager', `${URL}?teamId=${TEAM_A}`)).statusCode).toBe(403)
    expect(callsTo(mongoState, 'seats', 'find')).toEqual([])
  })
})

describe('GET /v1/dashboard/adoption/funnel', () => {
  const USER_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const t = today()
  const from = daysBefore(t, 6)
  const URL = `/v1/dashboard/adoption/funnel?from=${from}&to=${t}`
  const get = (role: JwtPayload['role'], url = URL) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  const row = (userId: string, name: string, over: Record<string, unknown> = {}) => ({
    userId,
    name,
    createdAt: new Date(`${daysBefore(t, 20)}T09:00:00Z`),
    hasDevice: true,
    firstSync: daysBefore(t, 60),
    lastSync: daysBefore(t, 1),
    activeDays: 0,
    ...over,
  })
  const invite = (email: string, teamId: string | null | undefined, daysAgo: number, usedAt: Date | null = null) => ({
    _id: `inv-${email}-${daysAgo}`,
    orgId: ORG_A,
    email,
    ...(teamId !== undefined && { teamId }),
    createdAt: new Date(`${daysBefore(t, daysAgo)}T09:00:00Z`),
    usedAt,
  })
  const counts = (invited: number, registered: number, deviceLinked: number, firstSync: number, active: number, powerUser: number) =>
    ({ invited, registered, deviceLinked, firstSync, active, powerUser })

  it('refuses a developer before reading anything', async () => {
    expect((await get('developer')).statusCode).toBe(403)
    expect(callsTo(mongoState, 'users', 'aggregate')).toEqual([])
  })

  it.each([`?from=${from}`, `?from=${t}&to=${from}`, ''])('rejects range %s', async (q) => {
    expect((await get('admin', `/v1/dashboard/adoption/funnel${q}`)).statusCode).toBe(400)
  })

  it('counts the org per team, invites once per email, and lists who is stuck', async () => {
    mongoState.docs.teams = [
      { _id: TEAM_A, orgId: ORG_A, name: 'Platform' },
      { _id: TEAM_B, orgId: ORG_A, name: 'Web' },
    ]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' },
      { teamId: TEAM_B, orgId: ORG_A, userId: USER_A, role: 'member' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
    mongoState.aggregates.users = [
      row(USER_A, 'Ada', { activeDays: 5 }),
      row(USER_B, 'Bo', { firstSync: null, lastSync: null }),
      row(USER_C, 'Cy', { hasDevice: false, activeDays: 1 }),
    ]
    mongoState.docs.users = [{ email: 'ada@x.io' }, { email: 'Bo@x.io' }, { email: 'cy@x.io' }]
    mongoState.docs.invites = [
      invite('new@x.io', TEAM_A, 2), // newest first, as the find sorts
      invite('NEW@x.io', TEAM_B, 9), // same person, older invite
      invite('bo@x.io', TEAM_A, 30), // Bo registered: never counted twice
      invite('bo@x.io', TEAM_A, 40, new Date()), // used: the filter drops it
      invite('old@x.io', undefined, 50), // pre-R0.5: No team
    ]

    const res = await get('admin')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const [pipeline] = callsTo(mongoState, 'users', 'aggregate')[0] as Document[][]
    expect(pipeline[0]).toEqual({ $match: { orgId: ORG_A, isActive: true } })
    expect(callsTo(mongoState, 'invites', 'find')[0][0]).toEqual({ orgId: ORG_A, usedAt: null })
    expect(callsTo(mongoState, 'users', 'find')[0][0]).toEqual({ orgId: ORG_A })

    expect(body).toMatchObject({ from, to: t, rangeDays: 7, activeDays: 2, powerDays: 5 })
    // Ada is in two teams and counts once here.
    expect(body.total).toEqual(counts(5, 3, 2, 2, 1, 1))
    expect(body.teams).toEqual([
      { teamId: TEAM_A, teamName: 'Platform', ...counts(3, 2, 2, 1, 1, 1) },
      { teamId: TEAM_B, teamName: 'Web', ...counts(1, 1, 1, 1, 1, 1) },
    ])
    expect(body.noTeam).toEqual(counts(2, 1, 0, 1, 0, 0))
    expect(body.stuck).toEqual([
      { stoppedAt: 'invited', userId: null, name: null, email: 'new@x.io', teams: ['Platform'], lastStepDate: daysBefore(t, 2) },
      { stoppedAt: 'invited', userId: null, name: null, email: 'old@x.io', teams: [], lastStepDate: daysBefore(t, 50) },
      { stoppedAt: 'registered', userId: USER_B, name: 'Bo', email: null, teams: ['Platform'], lastStepDate: daysBefore(t, 20) },
      { stoppedAt: 'firstSync', userId: USER_C, name: 'Cy', email: null, teams: [], lastStepDate: daysBefore(t, 1) },
    ])
  })

  it('limits a manager to their teams: no No-team row, no other teams or invites', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
    mongoState.aggregates.users = [row(USER_A, 'Ada', { activeDays: 2 }), row(USER_B, 'Bo')]
    mongoState.docs.users = [{ email: 'ada@x.io' }]
    mongoState.docs.invites = [invite('x@x.io', TEAM_A, 1), invite('y@x.io', TEAM_B, 1), invite('z@x.io', null, 1)]

    const body = (await get('manager')).json()
    const [pipeline] = callsTo(mongoState, 'users', 'aggregate')[0] as Document[][]
    expect(pipeline[0].$match._id.$in.sort()).toEqual([USER_A, USER_B].sort())
    expect(body.noTeam).toBeNull()
    expect(body.total).toEqual(counts(3, 2, 2, 2, 1, 0))
    expect(body.teams).toEqual([{ teamId: TEAM_A, teamName: 'Platform', ...counts(3, 2, 2, 2, 1, 0) }])
    expect(body.stuck.map((s: { name: string | null; email: string | null }) => s.name ?? s.email)).toEqual([
      'x@x.io',
      'Bo',
      'Ada',
    ])
  })

  it('narrows an admin to one team, with that team only and no No-team row', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [{ teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' }]
    mongoState.aggregates.users = [row(USER_A, 'Ada')]
    mongoState.docs.invites = [invite('x@x.io', TEAM_A, 1), invite('z@x.io', undefined, 1)]
    const body = (await get('admin', `${URL}&teamId=${TEAM_A}`)).json()
    expect(body.noTeam).toBeNull()
    expect(body.teams).toEqual([{ teamId: TEAM_A, teamName: 'Platform', ...counts(2, 1, 1, 1, 0, 0) }])
    expect(body.total.invited).toBe(2)
  })

  it('answers 404 to a team outside the org before reading people', async () => {
    expect((await get('admin', `${URL}&teamId=${TEAM_B}`)).statusCode).toBe(404)
    expect(callsTo(mongoState, 'users', 'aggregate')).toEqual([])
  })
})
