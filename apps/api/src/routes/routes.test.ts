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

// The fake store ignores filters, so a users read would count every seeded
// user, or none. Org size is set here instead: 5 by default, the smallest org
// an admin sees totals for. A test that needs a smaller org sets `orgSize.ids`.
const orgSize = vi.hoisted(() => ({ ids: [] as string[] }))
vi.mock('../plugins/org-people.js', () => ({ orgPeople: async () => orgSize.ids }))
// better-auth's collections are not store collections; record what the delete route asks for.
const logins = vi.hoisted(() => ({ deleted: [] as string[] }))
vi.mock('../auth-logins.js', () => ({
  deleteLogin: async (email: string) => (logins.deleted.push(email), 3),
}))

// Rate limiting is not what these tests cover. The plugin is a no-op here, so
// `config.rateLimit` on a route is simply inert metadata.
vi.mock('@fastify/rate-limit', () => ({ default: fp(async () => {}) }))

const { buildServer } = await import('../build-server.js')
const { getStore } = await import('@burn-watch/db')

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const USER_A = '33333333-3333-4333-8333-333333333333'
const USER_B = '77777777-7777-4777-8777-777777777777'
// Three more teammates, so a team of USER_A, USER_B and PEERS meets MIN_GROUP_SIZE (5).
const PEERS = [
  'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1',
  'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2',
  'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3',
]
/** teamMembers rows putting each of PEERS on a team as a plain member. */
const peerRows = (teamId: string) =>
  PEERS.map((userId) => ({ _id: `${teamId}:${userId}`, teamId, orgId: ORG_A, userId, role: 'member' }))
const TEAM_A = '88888888-8888-4888-8888-888888888888'
const TEAM_B = '99999999-9999-4999-8999-999999999999'
const DEVICE_A = '44444444-4444-4444-8444-444444444444'
const ALERT_A = '66666666-6666-4666-8666-666666666666'
const DATE = '2026-11-05'

const DASHBOARD_ROUTES = [
  '/v1/dashboard/overview',
  '/v1/dashboard/trends',
  '/v1/dashboard/activity',
  '/v1/dashboard/projects',
]

let app: FastifyInstance

// `/trends` takes `days` or `from`+`to` and does not accept `date`, which the
// other three do. A single-day range is the one query every dashboard route
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
  orgSize.ids = [USER_A, USER_B, ...PEERS]
  logins.deleted = []
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
  const SCOPED_URLS = DASHBOARD_ROUTES.map(range)

  // A manager of TEAM_A, which also holds USER_B and PEERS.
  const managerOfTeam = () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { _id: `${TEAM_A}:${USER_A}`, teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { _id: `${TEAM_A}:${USER_B}`, teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
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
    await expectScope(url, 'manager', [USER_A, USER_B, ...PEERS])
  })

  it('reads team rows only within the caller org, and only managed teams', async () => {
    managerOfTeam()
    await app.inject({ method: 'GET', url: range('/v1/dashboard/overview'), headers: auth(token({ role: 'manager' })) })
    const [first, second] = callsTo(mongoState, 'teamMembers', 'find')
    expect(first[0]).toEqual({ orgId: ORG_A, userId: USER_A, role: 'manager' })
    // The fake ignores filters, so which teams the $in names is a fake artifact; the org is not.
    expect(second[0]).toMatchObject({ orgId: ORG_A })
  })

  describe('minimum group size', () => {
    const TOO_SMALL = { error: 'group_too_small', minGroupSize: 5 }
    // TEAM_A with only USER_A and USER_B: below MIN_GROUP_SIZE.
    const teamOfTwo = () => {
      mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
      mongoState.docs.teamMembers = [
        { _id: `${TEAM_A}:${USER_A}`, teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
        { _id: `${TEAM_A}:${USER_B}`, teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ]
    }

    it.each([...DASHBOARD_ROUTES, '/v1/dashboard/tickets'].map(range))(
      'refuses a manager whose team has 2 people on %s, before reading data',
      async (url) => {
        teamOfTwo()
        const res = await app.inject({ method: 'GET', url, headers: auth(token({ role: 'manager' })) })
        expect(res.statusCode, url).toBe(403)
        expect(res.json(), url).toEqual(TOO_SMALL)
        expect(callsTo(mongoState, 'dailySnapshots', 'aggregate'), url).toEqual([])
        expect(callsTo(mongoState, 'claudeEnrichment', 'aggregate'), url).toEqual([])
      },
    )

    it.each([...DASHBOARD_ROUTES, '/v1/dashboard/tickets'].map(range))(
      'still gives a developer in a 2-person team their own data on %s',
      async (url) => {
        teamOfTwo()
        await expectScope(url, 'developer', [USER_A])
      },
    )
  })

  // budget-alerts is admin only (v2 Phase 3), so it is only in the admin case.
  it.each([...SCOPED_URLS, '/v1/dashboard/budget-alerts'])('lets an admin read the whole org on %s', async (url) => {
    managerOfTeam()
    await expectScope(url, 'admin', undefined)
    // The audit event names the viewer as actor by design; no data read may.
    const reads = mongoState.calls.filter((c) => c.collection !== 'auditEvents')
    expect(inspect(reads, { depth: null }), url).not.toContain(USER_A)
  })

  describe('an admin of an org under 5 people (v2.1)', () => {
    const asAdmin = (url: string) => app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })

    it.each(SCOPED_URLS)('refuses org totals for an org of 4 on %s', async (url) => {
      orgSize.ids = [USER_A, USER_B, PEERS[0], PEERS[1]]
      const res = await asAdmin(url)
      expect(res.statusCode, url).toBe(403)
      expect(res.json(), url).toEqual({ error: 'group_too_small', minGroupSize: 5 })
    })

    it.each(SCOPED_URLS)('lets an admin alone in the org read their own data on %s', async (url) => {
      orgSize.ids = [USER_A]
      expect((await asAdmin(url)).statusCode, url).toBe(200)
    })

    it.each(['/v1/dashboard/adoption/unused-seats', '/v1/dashboard/governance/setup-checks'])(
      'still answers the named admin list %s for an org of 4',
      async (url) => {
        orgSize.ids = [USER_A, USER_B, PEERS[0], PEERS[1]]
        expect((await asAdmin(range(url))).statusCode, url).toBe(200)
      },
    )
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
    const USER_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_C, role: 'member' },
      ...peerRows(TEAM_A),
    ]
    const res = await get(withTeam(url), 'admin')
    expect(res.statusCode).toBe(200)
    expectOnly([USER_B, USER_C, ...PEERS])
    // The team lookup is org-scoped, so another org's team id answers 404.
    expect(callsTo(mongoState, 'teams', 'findOne')[0][0]).toEqual({ _id: TEAM_A, orgId: ORG_A })
  })

  it.each(TEAM_ROUTES)('%s gives a manager their whole managed team', async (url) => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
    ]
    const res = await get(withTeam(url), 'manager')
    expect(res.statusCode).toBe(200)
    expectOnly([USER_A, USER_B, ...PEERS])
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

  it.each(TEAM_ROUTES)('%s refuses an admin filtering a team of 2 as too small', async (url) => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: PEERS[0], role: 'member' },
    ]
    const res = await get(withTeam(url), 'admin')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'group_too_small', minGroupSize: 5 })
    expect(callsTo(mongoState, 'dailySnapshots', 'aggregate')).toEqual([])
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

  const USER_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

  it('sums each team from its members, counting a shared member in both', async () => {
    mongoState.docs.teams = [
      { _id: TEAM_A, orgId: ORG_A, name: 'Platform' },
      { _id: TEAM_B, orgId: ORG_A, name: 'Mobile' },
    ]
    // USER_B and PEERS sit on both teams; only USER_A and USER_B have usage.
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
      { teamId: TEAM_B, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_B),
      { teamId: TEAM_B, orgId: ORG_A, userId: USER_C, role: 'member' },
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
    expect(platform).toMatchObject({ teamId: TEAM_A, memberCount: 5, activeUsers: 2, totalCostUsd: 3.5, totalTokens: 30 })
    expect(platform.daily).toEqual([{ date: DATE, totalCost: 3.5 }])
    expect(platform.byAgent.find((a) => a.agent === 'claude')).toMatchObject({ tokens: 15, costUsd: 2 })
    expect(mobile).toMatchObject({ teamId: TEAM_B, memberCount: 5, activeUsers: 1, totalCostUsd: 2, totalTokens: 20 })
    expect(mobile.byAgent.find((a) => a.agent === 'claude')).toMatchObject({ tokens: 5, costUsd: 0.5 })

    // One read, over the union of members, inside the caller's org.
    const [[pipeline]] = callsTo(mongoState, 'dailySnapshots', 'aggregate') as Document[][][]
    expect(pipeline[0].$match).toMatchObject({ orgId: ORG_A, userId: { $in: [USER_A, USER_B, ...PEERS, USER_C] } })
  })

  it('leaves out a team under the minimum group size', async () => {
    mongoState.docs.teams = [
      { _id: TEAM_A, orgId: ORG_A, name: 'Platform' },
      { _id: TEAM_B, orgId: ORG_A, name: 'Mobile' },
    ]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
      { teamId: TEAM_B, orgId: ORG_A, userId: USER_C, role: 'member' },
      { teamId: TEAM_B, orgId: ORG_A, userId: PEERS[0], role: 'member' },
    ]
    mongoState.aggregates.dailySnapshots = [{ users: [], agents: [], daily: [] }]

    const res = await get('admin')
    expect(res.statusCode).toBe(200)
    expect((res.json() as TeamComparison[]).map((t) => t.teamId)).toEqual([TEAM_A])
    // Mobile's only-there member is not read at all.
    const [[pipeline]] = callsTo(mongoState, 'dailySnapshots', 'aggregate') as Document[][][]
    expect(pipeline[0].$match).toMatchObject({ userId: { $in: [USER_A, USER_B, ...PEERS] } })
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
    // The label read comes first so the audit event can still name the team.
    expect(ops).toEqual(['teams.findOne', 'teamMembers.deleteMany', 'teams.deleteOne', 'auditEvents.insertOne'])
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

describe('GET /v1/dashboard/tickets', () => {
  const URL = range('/v1/dashboard/tickets')
  const get = (role: JwtPayload['role'] = 'developer') =>
    app.inject({ method: 'GET', url: URL, headers: auth(token({ role })) })
  const match = () =>
    (callsTo(mongoState, 'claudeEnrichment', 'aggregate')[0][0] as Document[])[0].$match as Record<string, unknown>
  const seed = () => {
    mongoState.aggregates.claudeEnrichment = [
      { _id: { branch: 'PROJ-1-fix', repo: 'api' }, cost: 4, sessions: 2, users: [USER_A], days: [DATE] },
      { _id: { branch: 'feature/proj-1', repo: 'web' }, cost: 1, sessions: 1, users: [USER_A], days: [DATE] },
      { _id: { branch: 'WEB-2-x', repo: 'web' }, cost: 0.5, sessions: 1, users: [USER_A], days: [DATE] },
    ]
    mongoState.docs.organizations = [{ _id: ORG_A, ticketPrefixes: ['PROJ'] }]
  }

  it('scopes a developer to themselves and hides suggestions', async () => {
    seed()
    const res = await get()
    expect(res.statusCode).toBe(200)
    expect(match()).toEqual({ orgId: ORG_A, userId: { $in: [USER_A] }, date: { $gte: DATE, $lte: DATE } })
    expect(res.json()).toEqual({
      from: DATE,
      to: DATE,
      prefixes: ['PROJ'],
      tickets: [{ key: 'PROJ-1', cost: 5, sessions: 3, userCount: 1, repoCount: 2, days: 1 }],
      projectKeys: [{ prefix: 'PROJ', tickets: 1, cost: 5, sessions: 3, userCount: 1 }],
      noTicket: { cost: 0.5, sessions: 1 },
      suggestions: null,
    })
  })

  it('gives an admin the whole org and prefix suggestions, never branch names', async () => {
    seed()
    const body = (await get('admin')).json()
    expect(match()).toEqual({ orgId: ORG_A, date: { $gte: DATE, $lte: DATE } })
    expect(body.suggestions).toEqual([{ prefix: 'WEB', branches: 1 }])
    // Branch names can be anything, so check each seeded name verbatim rather than a pattern.
    const json = JSON.stringify(body)
    for (const row of mongoState.aggregates.claudeEnrichment) {
      expect(json).not.toContain((row._id as { branch: string }).branch)
    }
  })

  it('answers prefixes null and no tickets before an admin sets keys', async () => {
    seed()
    mongoState.docs.organizations = [{ _id: ORG_A }]
    const body = (await get('admin')).json()
    expect(body).toMatchObject({ prefixes: null, tickets: [], noTicket: { cost: 5.5, sessions: 4 } })
  })

  it('requires a range', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dashboard/tickets', headers: auth(token()) })
    expect(res.statusCode).toBe(400)
  })
})

describe('PUT /v1/dashboard/tickets/settings', () => {
  const url = '/v1/dashboard/tickets/settings'
  const send = (payload: object, role: JwtPayload['role'] = 'admin') =>
    app.inject({ method: 'PUT', url, payload, headers: auth(token({ role })) })

  it.each(['developer', 'manager'] as const)('answers 403 to a %s and writes nothing', async (role) => {
    expect((await send({ prefixes: ['PROJ'] }, role)).statusCode).toBe(403)
    expect(mongoState.calls).toEqual([])
  })

  it.each([{ prefixes: ['proj'] }, { prefixes: ['P'] }, { prefixes: ['PROJ_X'] }, { prefixes: ['ABCDEFGHIJK'] }, {}])(
    'rejects %j with 400',
    async (body) => {
      expect((await send(body)).statusCode).toBe(400)
      expect(mongoCalls('organizations', 'updateOne')).toEqual([])
    },
  )

  it('sets deduplicated keys and audits them', async () => {
    expect((await send({ prefixes: ['PROJ', 'WEB', 'PROJ'] })).json()).toEqual({ prefixes: ['PROJ', 'WEB'] })
    expect(mongoCalls('organizations', 'updateOne')).toEqual([[{ _id: ORG_A }, { $set: { ticketPrefixes: ['PROJ', 'WEB'] } }]])
    const [event] = mongoCalls('auditEvents', 'insertOne').map(([d]) => d as Record<string, unknown>)
    expect(event).toMatchObject({ action: 'org.ticket_prefixes', detail: { prefixes: ['PROJ', 'WEB'] } })
  })

  it('clears with an empty list', async () => {
    await send({ prefixes: [] })
    expect(mongoCalls('organizations', 'updateOne')).toEqual([[{ _id: ORG_A }, { $unset: { ticketPrefixes: '' } }]])
  })
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

  // Every alert carries org spend, so only an admin reads them (v2 Phase 3).
  it.each(['manager', 'developer'] as const)('returns 403 for a %s, before reading alerts', async (role) => {
    mongoState.docs.budgetAlerts = [alertDoc()]
    const res = await get(auth(token({ role })))
    expect(res.statusCode).toBe(403)
    expect(mongoCalls('budgetAlerts', 'find')).toEqual([])
  })

  it('returns an empty array when the org has no alerts', async () => {
    const res = await get(auth(token({ role: 'admin' })))
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

    const res = await get(auth(token({ role: 'admin' })))
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

    const [row] = (await get(auth(token({ role: 'admin' })))).json() as Array<Record<string, unknown>>
    expect(row).toMatchObject({ monthlyLimitUsd: 100, monthToDateSpendUsd: 554.22, threshold: 0.8 })
  })

  // No names anywhere: not the alert's scope, not the idle seats, not who hit a limit.
  it('answers counts only, with no user ids or names', async () => {
    mongoState.docs.budgetAlerts = [
      alertDoc({ _id: 'alert-1' }),
      alertDoc({ _id: 'alert-2', type: 'idle-seat', idleDays: 14 }),
      alertDoc({ _id: 'alert-3', type: 'limit-hit', limitHits: 3 }),
    ]
    mongoState.docs.users = [{ _id: USER_B, orgId: ORG_A, name: 'Bo Otherperson', email: 'bo@example.com' }]
    mongoState.docs.seats = [
      { _id: `${USER_B}:claude`, orgId: ORG_A, userId: USER_B, agent: 'claude', startDate: '2026-01-01', monthlyPriceMicros: 20 * USD },
    ]
    mongoState.aggregates.claudeEnrichment = [{ n: 2 }]
    spend(0)

    const res = await get(auth(token({ role: 'admin' })))
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<Record<string, unknown>>
    for (const row of body) {
      expect(row).not.toHaveProperty('userId')
      expect(row).not.toHaveProperty('userName')
      expect(row).not.toHaveProperty('idleSeats')
    }
    for (const leak of [USER_A, USER_B, 'Bo Otherperson', 'bo@example.com']) expect(res.body).not.toContain(leak)
    expect(body.find((a) => a.id === 'alert-1')).toMatchObject({ type: 'api-spend', idleSeatCount: null, people: null })
    expect(body.find((a) => a.id === 'alert-2')).toMatchObject({ type: 'idle-seat', idleSeatCount: 1, people: null })
    expect(body.find((a) => a.id === 'alert-3')).toMatchObject({ type: 'limit-hit', idleSeatCount: null, people: 2 })
    // No name lookup at all.
    expect(mongoCalls('users', 'find')).toEqual([])
  })

  it('counts distinct people with a limit hit this month, in the caller org', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ type: 'limit-hit', limitHits: 3 })]
    spend(0)

    await get(auth(token({ role: 'admin', orgId: ORG_A })))

    const [pipeline] = mongoCalls('claudeEnrichment', 'aggregate')[0] as [Document[]]
    const t = today()
    expect(pipeline).toEqual([
      { $match: { orgId: ORG_A, date: { $gte: `${t.slice(0, 7)}-01`, $lte: t }, limitHitCount: { $gt: 0 } } },
      { $group: { _id: '$userId' } },
      { $count: 'n' },
    ])
  })

  it('reports 0 people when nobody hit a limit, and skips the read with no limit-hit alert', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ type: 'limit-hit', limitHits: 3 })]
    spend(0)
    const [row] = (await get(auth(token({ role: 'admin' })))).json() as Array<Record<string, unknown>>
    expect(row.people).toBe(0)

    mongoState.calls.length = 0
    mongoState.docs.budgetAlerts = [alertDoc()]
    await get(auth(token({ role: 'admin' })))
    expect(mongoCalls('claudeEnrichment', 'aggregate')).toEqual([])
  })

  it('reads month-to-date spend for the caller org and the alert scope only', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ agent: 'claude' })]
    spend(0)

    await get(auth(token({ role: 'admin', orgId: ORG_A })))

    const [pipeline] = mongoCalls('dailySnapshots', 'aggregate')[0] as [{ $match?: Record<string, unknown> }[]]
    expect(pipeline[0].$match).toMatchObject({ orgId: ORG_A })
    expect(pipeline[0].$match).not.toHaveProperty('userId')
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

  // v2 Phase 3: no per-person alerts. A userId in the body is dropped by the
  // schema and the alert is stored org-wide, without even a user lookup.
  it('ignores a userId in the body and stores the alert org-wide', async () => {
    mongoState.docs.users = [{ _id: USER_B, orgId: ORG_A }]
    const res = await post(auth(token({ role: 'admin' })), { monthlyLimitUsd: 500, userId: USER_B })
    expect(res.statusCode).toBe(201)
    const [written] = mongoCalls('budgetAlerts', 'insertOne')[0] as [Record<string, unknown>]
    expect(written.userId).toBeNull()
    expect(inspect(written, { depth: null })).not.toContain(USER_B)
    expect(mongoCalls('users', 'findOne')).toHaveLength(0)
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

  it('cannot point an alert at one person', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ _id: ALERT_A })]
    spend(0)
    const res = await patch(auth(token({ role: 'admin' })), { monthlyLimitUsd: 250, userId: USER_B })
    expect(res.statusCode).toBe(200)
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
      ...peerRows(TEAM_A),
    ]
    await app.inject({ method: 'GET', url: range('/v1/dashboard/overview'), headers: auth(token({ role: 'manager' })) })
    expect(mongoCalls('seats', 'find')[0][0]).toEqual({ orgId: ORG_A, userId: { $in: [USER_A, USER_B, ...PEERS] } })
  })
})

describe('GET /v1/dashboard/me/usage (v2 P1)', () => {
  const t = today()
  const from = daysBefore(t, 6)
  const URL = `/v1/dashboard/me/usage?from=${from}&to=${t}`
  const get = (role: JwtPayload['role'], url = URL) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  const OTHER = { _id: USER_B, orgId: ORG_A, name: 'Bo Otherperson', email: 'bo.other@example.com', isActive: true }
  const snap = (date: string, tokens: number, usd: number) => ({
    _id: `${USER_A}:${date}`,
    orgId: ORG_A,
    userId: USER_A,
    date,
    totalTokens: tokens,
    sessionCount: 2,
    totalCostMicros: usd * USD,
    byAgent: { claude: { tokens, costMicros: usd * USD } },
  })
  // The fake ignores filters and answers with every seeded row, so only the
  // caller's rows are seeded and the filters are read off the calls instead.
  // src/scripts/no-individuals.ts checks the filtering on a real server.
  const seed = () => {
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A, name: 'Ada', email: 'ada@example.com' }, OTHER]
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
    ]
    mongoState.docs.dailySnapshots = [snap(daysBefore(t, 1), 300, 2), snap(t, 700, 3)]
    mongoState.aggregates.claudeEnrichment = [{ _id: USER_A, servers: ['linear', 'github'] }]
    mongoState.docs.claudeEnrichment = [{ orgId: ORG_A, userId: USER_A, date: daysBefore(t, 1), mcpUsage: { github: 1 } }]
  }

  it.each(['admin', 'manager', 'developer'] as const)('gives a %s only their own numbers', async (role) => {
    seed()
    const res = await get(role)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toEqual({
      from,
      to: t,
      rangeDays: 2, // counted from the first day ever used, not from `from`
      activeDays: 2,
      consecutiveDays: { current: 2, longest: 2, lastActive: t },
      totalTokens: 1000,
      sessions: 4,
      totalCostUsd: 5,
      agents: [{ agent: 'claude', tokens: 1000, costUsd: 5 }],
      features: { agents: ['claude'], mcpServers: ['github', 'linear'] },
      // The caller's own first 14 days, from their first day with tokens.
      onboarding: {
        firstSync: daysBefore(t, 1),
        state: 'inProgress',
        activeWeek1: 2,
        activeWeek2: 0,
        features: ['mcp'],
        dayOfWindow: 1,
      },
      helpVolunteer: false,
      seats: [],
      freeTier: [],
      setupChecks: [],
      accountFlags: [],
    })
    // Every data read is pinned to the caller, whatever the role.
    const finds = callsTo(mongoState, 'dailySnapshots', 'find').map(([f]) => f)
    expect(finds).toHaveLength(2)
    for (const f of finds) expect(f).toMatchObject({ orgId: ORG_A, userId: USER_A })
    const [pipeline] = callsTo(mongoState, 'claudeEnrichment', 'aggregate')[0] as Document[][]
    expect(pipeline[0].$match).toMatchObject({ orgId: ORG_A, userId: { $in: [USER_A] } })
    const [enrichment] = callsTo(mongoState, 'claudeEnrichment', 'find')
    expect(enrichment[0]).toMatchObject({ orgId: ORG_A, userId: USER_A })
    // The one users read is the caller's own document, for the help flag.
    expect(mongoState.calls.filter((call) => call.collection === 'users').map((call) => [call.op, call.args[0]])).toEqual([
      ['findOne', { _id: USER_A, orgId: ORG_A }],
    ])
    // No scope lookup, no roster read: nothing that could widen it to a team or the org.
    for (const c of ['teams', 'teamMembers']) {
      expect(mongoState.calls.filter((call) => call.collection === c), c).toEqual([])
    }
    const text = res.body
    for (const leak of [USER_B, ...PEERS, OTHER.name, OTHER.email, 'Ada', 'ada@example.com']) expect(text).not.toContain(leak)
  })

  it('reads consecutive days from all-time snapshots', async () => {
    seed()
    await get('developer')
    const [, runFilter] = callsTo(mongoState, 'dailySnapshots', 'find').map(([f]) => f as Record<string, unknown>)
    expect(runFilter).toEqual({ orgId: ORG_A, userId: USER_A, totalTokens: { $gt: 0 } })
  })

  it('answers zeros and no consecutive days with no usage', async () => {
    const body = (await get('developer')).json()
    expect(body).toMatchObject({ activeDays: 0, totalTokens: 0, totalCostUsd: 0, agents: [], consecutiveDays: { current: 0, longest: 0, lastActive: null } })
    expect(body.onboarding).toBeNull()
    expect(body.helpVolunteer).toBe(false)
    expect(body).toMatchObject({ seats: [], freeTier: [], setupChecks: [], accountFlags: [] })
    // No onboarding read without a first sync; the one find is the account-flag read over the range.
    expect(callsTo(mongoState, 'claudeEnrichment', 'find').map(([f]) => f)).toEqual([
      { orgId: ORG_A, userId: USER_A, date: { $gte: from, $lte: t } },
    ])
  })

  // v2 Phase 3 symmetry: what an admin sees about a person, the person sees too.
  describe('own status (v2 P3)', () => {
    const seedStatus = () => {
      seed()
      mongoState.docs.seats = [
        { _id: `${USER_A}:claude`, orgId: ORG_A, userId: USER_A, agent: 'claude', startDate: daysBefore(t, 9), monthlyPriceMicros: 20 * USD },
      ]
      // seatLastUsed's answer: claude last used today.
      mongoState.aggregates.dailySnapshots = [{ _id: { userId: USER_A, agent: 'claude' }, lastUsed: t }]
      // One answer serves both usageEvents reads, so it carries the fields of
      // a free-tier model group and of a setup-check group.
      mongoState.aggregates.usageEvents = [
        {
          _id: { userId: USER_A, agent: 'gemini', modelName: 'gemini-2.5-pro' },
          users: [USER_A],
          days: 2,
          tokens: 900,
          firstDate: daysBefore(t, 2),
          lastDate: t,
        },
      ]
      mongoState.docs.agentPolicies = [{ _id: `${ORG_A}:gemini`, orgId: ORG_A, agent: 'gemini', rule: 'blocked', models: [] }]
      // The fake answers every find with all of these, so USER_B's day sharing
      // account h1 comes back as an "other" and USER_A gets the shared flag.
      mongoState.docs.claudeEnrichment = [
        { orgId: ORG_A, userId: USER_A, date: daysBefore(t, 1), accountHashes: ['h1'], claudeOrgHashes: ['o1'] },
        { orgId: ORG_A, userId: USER_B, date: daysBefore(t, 1), accountHashes: ['h1'] },
      ]
    }

    it('answers seats, free tier, setup checks and account flags for the caller', async () => {
      seedStatus()
      const res = await get('developer')
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.seats).toEqual([{ agent: 'claude', daysUnused: 0 }]) // used today
      expect(body.freeTier).toEqual([
        { agent: 'gemini', modelName: 'gemini-2.5-pro', reason: 'unpriced-model', people: 1, days: 2, tokens: 900 },
      ])
      expect(body.setupChecks).toEqual([
        { agent: 'gemini', modelName: 'gemini-2.5-pro', reason: 'agent-blocked', days: 2, tokens: 900 },
      ])
      expect(body.accountFlags).toContain('shared')
    })

    it.each(['admin', 'manager', 'developer'] as const)('filters every read to the caller for a %s', async (role) => {
      seedStatus()
      const res = await get(role)
      expect(res.statusCode).toBe(200)

      const isCaller = (f: unknown) => f === USER_A || JSON.stringify(f) === JSON.stringify({ $in: [USER_A] })
      for (const c of mongoState.calls) {
        const [filter] = c.args as [Record<string, unknown>]
        const where = `${c.collection}.${c.op} ${JSON.stringify(c.args[0])}`
        // Org settings, not anyone's data.
        if (c.collection === 'agentPolicies' || c.collection === 'organizations') {
          expect(filter, where).toEqual(c.collection === 'organizations' ? { _id: ORG_A } : { orgId: ORG_A })
          continue
        }
        if (c.collection === 'users') {
          expect(filter, where).toEqual({ _id: USER_A, orgId: ORG_A })
          continue
        }
        // Whether the org entered any Claude seat, for the seat flags. Only _id, no one's id.
        if (c.collection === 'seats' && filter.agent === 'claude' && !('userId' in filter)) {
          expect(c.args).toEqual([{ orgId: ORG_A, agent: 'claude' }, { projection: { _id: 1 } }])
          continue
        }
        // The account-sharing read: only other people's days on the caller's
        // own account hashes, and only the fields that make the shared flag.
        if (c.collection === 'claudeEnrichment' && JSON.stringify(filter.userId) === JSON.stringify({ $ne: USER_A })) {
          expect(c.args, where).toEqual([
            { orgId: ORG_A, userId: { $ne: USER_A }, date: { $gte: from, $lte: t }, accountHashes: { $in: ['h1'] } },
            { projection: { userId: 1, date: 1, accountHashes: 1 } },
          ])
          continue
        }
        const json = JSON.stringify(c.args)
        expect(json, where).toContain(ORG_A)
        const userIds: unknown[] = []
        const walk = (n: unknown): void => {
          if (Array.isArray(n)) return n.forEach(walk)
          if (!n || typeof n !== 'object') return
          for (const [k, v] of Object.entries(n)) {
            if (k === 'userId' && !(typeof v === 'string' && v.startsWith('$')) && typeof v !== 'number') userIds.push(v)
            else walk(v)
          }
        }
        walk(c.args)
        expect(userIds.length, where).toBeGreaterThan(0)
        for (const f of userIds) expect(isCaller(f), where).toBe(true)
      }
      // The sharing read did run, so the exception above was exercised.
      expect(callsTo(mongoState, 'claudeEnrichment', 'find').some(([f]) => (f as Record<string, unknown>).accountHashes)).toBe(true)

      for (const leak of [USER_B, ...PEERS, OTHER.name, OTHER.email, 'h1', 'o1']) expect(res.body).not.toContain(leak)
    })
  })

  it('returns the caller\'s own help flag', async () => {
    seed()
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A, name: 'Ada', helpVolunteer: true }]
    expect((await get('developer')).json().helpVolunteer).toBe(true)
  })

  it.each(['', `?from=${t}`, '?from=20261101&to=20261102', '?date=not-a-date'])('rejects query %s', async (q) => {
    expect((await get('developer', `/v1/dashboard/me/usage${q}`)).statusCode).toBe(400)
    expect(callsTo(mongoState, 'dailySnapshots', 'find')).toEqual([])
  })
})

describe('PUT /v1/dashboard/me/help-volunteer (v2 P2)', () => {
  const put = (payload: unknown, role: JwtPayload['role'] = 'developer') =>
    app.inject({ method: 'PUT', url: '/v1/dashboard/me/help-volunteer', headers: auth(token({ role })), payload: payload as object })

  it.each(['admin', 'manager', 'developer'] as const)('lets a %s set only their own flag', async (role) => {
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A }]
    // Extra fields naming someone else are ignored: the filter comes from the token.
    const res = await put({ helpVolunteer: true, userId: USER_B, _id: USER_B, orgId: ORG_B }, role)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ helpVolunteer: true })
    expect(callsTo(mongoState, 'users', 'updateOne')).toEqual([[{ _id: USER_A, orgId: ORG_A }, { $set: { helpVolunteer: true } }]])
    expect(mongoState.calls.filter((c) => c.op !== 'updateOne' && c.collection === 'users')).toEqual([])
    expect(callsTo(mongoState, 'auditEvents', 'insertOne')).toEqual([])
  })

  it('turns the flag off', async () => {
    expect((await put({ helpVolunteer: false })).json()).toEqual({ helpVolunteer: false })
    expect(callsTo(mongoState, 'users', 'updateOne')[0][1]).toEqual({ $set: { helpVolunteer: false } })
  })

  it.each([{}, { helpVolunteer: 'yes' }, { helpVolunteer: 1 }, { helpVolunteer: null }])('rejects body %j', async (body) => {
    expect((await put(body)).statusCode).toBe(400)
    expect(callsTo(mongoState, 'users', 'updateOne')).toEqual([])
    expect(callsTo(mongoState, 'auditEvents', 'insertOne')).toEqual([])
  })

  it('refuses without a token', async () => {
    const res = await app.inject({ method: 'PUT', url: '/v1/dashboard/me/help-volunteer', payload: { helpVolunteer: true } })
    expect(res.statusCode).toBe(401)
    expect(callsTo(mongoState, 'users', 'updateOne')).toEqual([])
  })
})

describe('GET /v1/dashboard/usage-distribution (v2 P1)', () => {
  const t = today()
  const from = daysBefore(t, 6) // 7 days
  const URL = `/v1/dashboard/usage-distribution?from=${from}&to=${t}`
  const get = (role: JwtPayload['role'], url = URL) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  const TOO_SMALL = { error: 'group_too_small', minGroupSize: 5 }
  const TEAM = [USER_A, USER_B, ...PEERS]
  const managerOfFive = () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
    ]
    // The fake ignores the users filter, so seed exactly the active people in scope.
    mongoState.docs.users = TEAM.map((_id) => ({ _id }))
  }

  it('refuses a developer before reading anything', async () => {
    expect((await get('developer')).statusCode).toBe(403)
    expect(mongoState.calls).toEqual([])
  })

  it('counts a manager of a 5-person team into bands that sum to people, with no ids', async () => {
    managerOfFive()
    mongoState.aggregates.dailySnapshots = [
      { _id: USER_A, days: 7 },
      { _id: USER_B, days: 1 },
      { _id: PEERS[0], days: 3 },
    ]
    const res = await get('manager')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toEqual({ from, to: t, people: 5, bands: { none: 2, '1-2': 1, '3-4': 1, '5+': 1 } })
    expect(Object.values(body.bands as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(body.people)
    for (const id of TEAM) expect(res.body).not.toContain(id)

    const [usersFilter] = callsTo(mongoState, 'users', 'find')[0] as [{ _id: { $in: string[] } }]
    expect(usersFilter).toMatchObject({ orgId: ORG_A, isActive: true })
    expect([...usersFilter._id.$in].sort()).toEqual([...TEAM].sort())
    const [pipeline] = callsTo(mongoState, 'dailySnapshots', 'aggregate')[0] as Document[][]
    expect(pipeline[0].$match).toMatchObject({ orgId: ORG_A, date: { $gte: from, $lte: t }, totalTokens: { $gt: 0 } })
    expect([...pipeline[0].$match.userId.$in].sort()).toEqual([...TEAM].sort())
  })

  it('refuses a manager whose team has fewer than 5 people', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
    ]
    const res = await get('manager')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual(TOO_SMALL)
    expect(callsTo(mongoState, 'dailySnapshots', 'aggregate')).toEqual([])
  })

  it('refuses an admin whose org has fewer than 5 active people, and audits nothing', async () => {
    mongoState.docs.users = [USER_A, USER_B, PEERS[0], PEERS[1]].map((_id) => ({ _id }))
    const res = await get('admin')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual(TOO_SMALL)
    expect(callsTo(mongoState, 'users', 'find')[0][0]).toEqual({ orgId: ORG_A, isActive: true })
    expect(callsTo(mongoState, 'dailySnapshots', 'aggregate')).toEqual([])
    expect(mongoState.calls.filter((c) => c.collection === 'auditEvents')).toEqual([])
  })

  it.each([`?from=${from}`, `?from=${t}&to=${from}`, `?from=${from}&to=${t}&teamId=not-a-team`])(
    'rejects query %s',
    async (q) => {
      expect((await get('admin', `/v1/dashboard/usage-distribution${q}`)).statusCode).toBe(400)
    },
  )
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

  it('returns type, idleDays and how many seats are idle, without names', async () => {
    mongoState.docs.budgetAlerts = [alertDoc({ type: 'idle-seat', idleDays: 14, limitHits: null })]
    mongoState.docs.seats = [{ _id: `${USER_B}:claude`, orgId: ORG_A, userId: USER_B, agent: 'claude', startDate: '2026-01-01' }]
    mongoState.docs.users = [{ _id: USER_B, name: 'Bo' }]
    mongoState.aggregates.dailySnapshots = [] // no active pairs, and no spend
    const res = await app.inject({ method: 'GET', url: '/v1/dashboard/budget-alerts', headers: auth(token({ role: 'admin' })) })
    const [row] = res.json()
    expect(row).toMatchObject({ type: 'idle-seat', idleDays: 14, limitHits: null, idleSeatCount: 1, people: null })
    expect(res.body).not.toContain(USER_B)
    expect(res.body).not.toContain('Bo')
  })

  it('reports idleSeatCount null for an api-spend alert', async () => {
    mongoState.docs.budgetAlerts = [alertDoc()]
    spend(0)
    const [row] = (await app.inject({ method: 'GET', url: '/v1/dashboard/budget-alerts', headers: auth(token({ role: 'admin' })) })).json()
    expect(row).toMatchObject({ type: 'api-spend', idleSeatCount: null, people: null })
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

  it('stores unpriced only on a row that says so', async () => {
    liveDeviceToken()
    knownUser()
    await submit({ ...payload, events: [{ ...event, modelName: 'new-model', costUsd: 0, unpriced: true }, event] })

    const [ops] = mongoCalls('usageEvents', 'bulkWrite')[0] as [
      { updateOne: { update: { $setOnInsert: Record<string, unknown> } } }[],
    ]
    expect(ops[0].updateOne.update.$setOnInsert.unpriced).toBe(true)
    expect(ops[1].updateOne.update.$setOnInsert).not.toHaveProperty('unpriced')
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

  it('accepts a 0.5 agent that still sends its collector diff, and drops the diff', async () => {
    liveDeviceToken()
    knownUser()
    const referenceDiff = [{ agent: 'claude', refTokens: 10, ownTokens: 10, refCostUsd: 1.5, ownCostUsd: 1.5 }]
    const res = await submit({ ...payload, agentVersion: '0.5.0', referenceDiff })
    expect(res.statusCode).toBe(200)
    const [[, update]] = mongoCalls('devices', 'updateOne') as [unknown, { $set: Record<string, unknown> }][]
    expect(Object.keys(update.$set)).toEqual(['lastSeenAt', 'agentVersion'])
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

describe('DELETE /v1/auth/admin/users/:id', () => {
  const del = (id: string, role: JwtPayload['role'] = 'admin') =>
    app.inject({ method: 'DELETE', url: `/v1/auth/admin/users/${id}`, headers: auth(token({ role })) })
  const deletes = () => mongoState.calls.filter((c) => c.op === 'deleteMany' || c.op === 'deleteOne')

  it.each(['developer', 'manager'] as const)('returns 403 for a %s and deletes nothing', async (role) => {
    expect((await del(USER_B, role)).statusCode).toBe(403)
    expect(deletes()).toEqual([])
    expect(logins.deleted).toEqual([])
  })

  it('refuses to delete the caller, so an org always keeps an admin', async () => {
    const res = await del(USER_A)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('You cannot delete yourself')
    expect(deletes()).toEqual([])
  })

  it('answers 404 for a user outside the caller org, and deletes nothing', async () => {
    expect((await del(USER_B)).statusCode).toBe(404)
    expect(mongoCalls('users', 'findOne')[0][0]).toEqual({ _id: USER_B, orgId: ORG_A })
    expect(deletes()).toEqual([])
    expect(logins.deleted).toEqual([])
  })

  it('deletes the person, their usage, places, devices, invites and login, then logs it', async () => {
    mongoState.docs.users = [{ _id: USER_B, orgId: ORG_A, email: 'bo@example.com', role: 'developer' }]
    mongoState.docs.devices = [{ _id: DEVICE_A, userId: USER_B }]
    const res = await del(USER_B)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ userId: USER_B })
    const byUser = { orgId: ORG_A, userId: USER_B }
    expect(Object.fromEntries(deletes().filter((c) => c.collection !== 'auditEvents').map((c) => [c.collection, c.args[0]]))).toEqual({
      usageEvents: byUser,
      dailySnapshots: byUser,
      claudeEnrichment: byUser,
      seats: byUser,
      teamMembers: byUser,
      budgetAlerts: byUser,
      deviceTokens: { deviceId: { $in: [DEVICE_A] } },
      devices: { userId: USER_B },
      pendingDevices: { email: 'bo@example.com' },
      invites: { orgId: ORG_A, email: 'bo@example.com' },
      users: { _id: USER_B, orgId: ORG_A },
    })
    expect(logins.deleted).toEqual(['bo@example.com'])
    const [[event]] = mongoCalls('auditEvents', 'insertOne') as [[Record<string, unknown>]]
    expect(event).toMatchObject({
      action: 'user.delete',
      actorId: USER_A,
      target: { type: 'user', id: USER_B, label: 'bo@example.com' },
      detail: { email: 'bo@example.com', role: 'developer' },
    })
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
    reporting: true,
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

  it('joins devices only, never usage', async () => {
    await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })
    // v2 rules 1 and 3: the roster carries no usage, so it reads no snapshots.
    const lookups = pipeline()
      .filter((s) => '$lookup' in s)
      .map((s) => s.$lookup as Record<string, unknown>)
    expect(lookups.map((l) => [l.from, l.localField, l.foreignField])).toEqual([['devices', '_id', 'userId']])
  })

  it('hands back the roster rows unchanged, never an _id', async () => {
    mongoState.aggregates.users = [
      row({ deviceCount: 0, hostnames: [], reporting: false }),
    ]
    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      row({ deviceCount: 0, hostnames: [], reporting: false }),
    ])
    const project = pipeline().at(-1)!.$project as Record<string, unknown>
    expect(project._id).toBe(0)
    expect(project.id).toBe('$_id')
  })

  it('returns no usage numbers or activity dates, only whether the agent reports', async () => {
    await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })
    const project = pipeline().at(-1)!.$project as Record<string, unknown>
    for (const k of ['lastSeenAt', 'lastSyncDate', 'totalCostUsd', 'totalTokens', 'activeDays']) expect(project).not.toHaveProperty(k)
    expect(project.reporting).toEqual({ $gte: [{ $max: '$devices.lastSeenAt' }, expect.any(Date)] })
  })

  it('sorts by name, never by usage', async () => {
    mongoState.aggregates.users = [
      row({ id: 'b', name: 'Bo' }),
      row({ id: 'a', name: 'Ada' }),
    ]
    const res = await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })
    expect(res.json().map((u: { name: string }) => u.name)).toEqual(['Ada', 'Bo'])
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
      // The audit event lands after the transaction body, never inside it.
      expect(ops).toEqual(['.transaction', 'invites.findOneAndUpdate', 'users.insertOne', 'auditEvents.insertOne'])
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
    reporting: true,
    userName: 'Dev One',
    userEmail: 'dev1@example.com',
    revoked: false,
    agentVersion: '0.4.0',
    claudeVersion: '2.1.330',
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
  })

  it('reports a coarse flag and sorts by name, never by when a laptop was last seen', async () => {
    await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })
    const project = pipeline().at(-1)!.$project as Record<string, unknown>
    expect(project).not.toHaveProperty('lastSeenAt')
    expect(project.reporting).toEqual({ $gte: ['$device.lastSeenAt', expect.any(Date)] })
    expect(pipeline().find((s) => '$sort' in s)).toEqual({ $sort: { name: 1, 'device.hostname': 1 } })
    expect(project._id).toBe(0)
  })
  it('projects both versions, reading a missing claudeVersion as null', async () => {
    await app.inject({ method: 'GET', url, headers: auth(token({ role: 'admin' })) })

    const project = pipeline().at(-1)!.$project as Record<string, unknown>
    expect(project.agentVersion).toBe('$device.agentVersion')
    expect(project.claudeVersion).toEqual({ $ifNull: ['$device.claudeVersion', null] })
  })
})

describe('/v1/auth/admin/device-settings', () => {
  const url = '/v1/auth/admin/device-settings'
  const send = (method: 'GET' | 'PUT', payload?: object, over: Partial<JwtPayload> = { role: 'admin' }) =>
    app.inject({ method, url, payload, headers: auth(token(over)) })

  it.each(['developer', 'manager', 'device'] as const)('answers 403 to a %s on GET and PUT', async (role) => {
    expect((await send('GET', undefined, { role })).statusCode).toBe(403)
    expect((await send('PUT', { minClaudeVersion: '2.1.0' }, { role })).statusCode).toBe(403)
    expect(mongoCalls('organizations', 'updateOne')).toEqual([])
    expect(mongoCalls('auditEvents', 'insertOne')).toEqual([])
  })

  it('reads null when the org has no minimum, from the org in the token', async () => {
    mongoState.docs.organizations = [{ _id: ORG_B, name: 'Acme' }]
    const res = await app.inject({
      method: 'GET',
      url: `${url}?orgId=${ORG_A}`,
      headers: auth(token({ role: 'admin', orgId: ORG_B })),
    })
    expect(res.json()).toEqual({ minClaudeVersion: null })
    expect(mongoCalls('organizations', 'findOne')[0][0]).toEqual({ _id: ORG_B })
  })

  it('reads the stored minimum', async () => {
    mongoState.docs.organizations = [{ _id: ORG_A, minClaudeVersion: '2.1.0' }]
    expect((await send('GET')).json()).toEqual({ minClaudeVersion: '2.1.0' })
  })

  it.each(['2.1', 'latest', '2.1.0-beta', 'v2.1.0', '', '1.2.34567890123456789'])('rejects %j with 400', async (v) => {
    expect((await send('PUT', { minClaudeVersion: v })).statusCode).toBe(400)
    expect(mongoCalls('organizations', 'updateOne')).toEqual([])
  })

  it('sets a version on the caller org and audits it', async () => {
    const res = await send('PUT', { minClaudeVersion: '2.1.0' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ minClaudeVersion: '2.1.0' })
    expect(mongoCalls('organizations', 'updateOne')).toEqual([[{ _id: ORG_A }, { $set: { minClaudeVersion: '2.1.0' } }]])
    const events = mongoCalls('auditEvents', 'insertOne').map(([doc]) => doc as Record<string, unknown>)
    expect(events).toEqual([
      expect.objectContaining({
        action: 'org.min_claude_version',
        target: expect.objectContaining({ type: 'org', id: ORG_A }),
        detail: { minClaudeVersion: '2.1.0' },
      }),
    ])
  })

  it('clears the minimum with null', async () => {
    const res = await send('PUT', { minClaudeVersion: null })
    expect(res.json()).toEqual({ minClaudeVersion: null })
    expect(mongoCalls('organizations', 'updateOne')).toEqual([[{ _id: ORG_A }, { $unset: { minClaudeVersion: '' } }]])
    expect(mongoCalls('auditEvents', 'insertOne').map(([doc]) => (doc as Record<string, unknown>).detail)).toEqual([
      { minClaudeVersion: null },
    ])
  })

  it('still answers 200 when the audit write fails', async () => {
    mongoState.failOn = 'auditEvents.insertOne'
    expect((await send('PUT', { minClaudeVersion: '2.1.0' })).statusCode).toBe(200)
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

  // One group per (agent, model), with the people in it for counting.
  const seedGroups = () => {
    mongoState.aggregates.usageEvents = [
      { _id: { agent: 'qwen', modelName: 'coder-model' }, users: [USER_A, USER_B], days: 3, tokens: 900 },
      { _id: { agent: 'claude', modelName: 'claude-new' }, users: [USER_B], days: 1, tokens: 100 },
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
    expect((await get('admin')).json()).toEqual({ people: 0, rows: [] })
    expect(match()).toEqual({ orgId: ORG_A, isFreeTier: true, date: { $gte: DATE, $lte: DATE } })
    expect(callsTo(mongoState, 'users', 'find')).toEqual([])
  })

  it('groups per agent and model, collecting people to count rather than to name', async () => {
    await get('admin')
    const [pipeline] = callsTo(mongoState, 'usageEvents', 'aggregate')[0] as Document[][]
    expect(pipeline[1]).toEqual({
      $group: {
        _id: { agent: '$agent', modelName: '$modelName' },
        users: { $addToSet: '$userId' },
        dates: { $addToSet: '$date' },
        tokens: { $sum: '$totalTokens' },
      },
    })
    expect(pipeline[2]).toEqual({ $project: { users: 1, days: { $size: '$dates' }, tokens: 1 } })
  })

  // v2 Phase 3: counts only. No names, ids, emails or team names.
  it('says why each model was flagged and counts distinct people, naming nobody', async () => {
    seedGroups()
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [{ teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' }]
    for (const role of ['admin', 'manager'] as const) {
      const res = await get(role)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        people: 2,
        rows: [
          { agent: 'qwen', modelName: 'coder-model', reason: 'free-tier-agent', people: 2, days: 3, tokens: 900 },
          { agent: 'claude', modelName: 'claude-new', reason: 'unpriced-model', people: 1, days: 1, tokens: 100 },
        ],
      })
      for (const leak of [USER_A, USER_B, 'Ada', 'Bo', 'ada@x.test', 'bo@x.test', 'Platform']) expect(res.body).not.toContain(leak)
    }
    expect(callsTo(mongoState, 'users', 'find')).toEqual([])
  })

  it('limits a manager to themselves and the teams they manage', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
    ]
    expect((await get('manager')).statusCode).toBe(200)
    expect(match().userId).toEqual({ $in: [USER_A, USER_B, ...PEERS] })
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
      { _id: 'playwright', calls: 40, people: 2, days: 2, lastDate: '2026-11-05' },
      { _id: 'plugin_vercel_vercel', calls: 9, people: 1, days: 1, lastDate: '2026-11-04' },
      { _id: 'claude_ai_Neon', calls: 3, people: 1, days: 1, lastDate: '2026-11-03' },
      { _id: '1a59c906-04da-521d-bda7-7f71b9f9e01c', calls: 1, people: 1, days: 1, lastDate: '2026-11-02' },
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

  it('lists servers with source, approval and a people count, plus approvals nobody used', async () => {
    seed()
    const res = await get('admin')
    expect(res.statusCode).toBe(200)
    expect(match()).toEqual({ orgId: ORG_A, date: { $gte: DATE, $lte: DATE } })
    expect(callsTo(mongoState, 'mcpApprovals', 'find')[0][0]).toEqual({ orgId: ORG_A })
    // v2 Phase 3: no name lookup, and the pipeline hands back a count, not ids.
    expect(callsTo(mongoState, 'users', 'find')).toEqual([])
    const [pipeline] = callsTo(mongoState, 'claudeEnrichment', 'aggregate')[0] as Document[][]
    const project = pipeline.filter((st) => st.$project).at(-1)?.$project
    expect(project).toMatchObject({ people: { $size: '$users' } })
    expect(project).not.toHaveProperty('users')
    for (const leak of [USER_A, USER_B, 'Ada', 'Bo']) expect(res.body).not.toContain(leak)
    const body = res.json()
    expect(body.servers[0]).toEqual({
      server: 'playwright',
      source: 'local',
      approved: true,
      note: 'browser tests',
      people: 2,
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
      ...peerRows(TEAM_A),
    ]
    expect((await get('manager')).statusCode).toBe(200)
    expect(match().userId).toEqual({ $in: [USER_A, USER_B, ...PEERS] })
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

describe('GET /v1/dashboard/governance/accounts', () => {
  const URL = range('/v1/dashboard/governance/accounts')
  const get = (role: JwtPayload['role'], url = URL) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  const ACC = 'a'.repeat(64)
  const OWN = 'c'.repeat(64)
  const OTHER = 'd'.repeat(64)
  const seed = () => {
    mongoState.docs.claudeEnrichment = [
      { userId: USER_A, orgId: ORG_A, date: DATE, accountHashes: [ACC], claudeOrgHashes: [OWN] },
      { userId: USER_B, orgId: ORG_A, date: DATE, accountHashes: [ACC], claudeOrgHashes: [OTHER] },
      { userId: TEAM_B, orgId: ORG_A, date: DATE, accountHashes: null, claudeOrgHashes: null },
    ]
    mongoState.docs.users = [
      { _id: USER_A, orgId: ORG_A, name: 'Ada' },
      { _id: USER_B, orgId: ORG_A, name: 'Bo' },
    ]
  }

  it.each(['developer', 'manager'] as const)('refuses a %s before reading anything', async (role) => {
    seed()
    expect((await get(role)).statusCode).toBe(403)
    expect(mongoState.calls).toEqual([])
  })

  it('requires a full range', async () => {
    expect((await get('admin', '/v1/dashboard/governance/accounts')).statusCode).toBe(400)
  })

  it('reads only the hash fields and answers with labels, coverage and flags', async () => {
    seed()
    mongoState.docs.organizations = [{ _id: ORG_A, ownClaudeOrgHashes: [OWN] }]
    mongoState.docs.seats = [{ _id: 's', orgId: ORG_A, userId: USER_A, agent: 'claude' }]
    const res = await get('admin')
    expect(res.statusCode).toBe(200)
    const [filter, opts] = callsTo(mongoState, 'claudeEnrichment', 'find')[0] as [object, { projection: object }]
    expect(filter).toEqual({ orgId: ORG_A, date: { $gte: DATE, $lte: DATE } })
    expect(opts.projection).toEqual({ userId: 1, date: 1, accountHashes: 1, claudeOrgHashes: 1 })
    expect(callsTo(mongoState, 'seats', 'find')[0][0]).toEqual({ orgId: ORG_A, agent: 'claude' })
    const body = res.json()
    expect(body).toMatchObject({ coverage: { users: 3, hashed: 2 }, companyOrgSet: true, seatsEntered: 1, companyOrgUsers: 1 })
    expect(body.accounts).toEqual([{ label: 'Account 1', users: 2, days: 1, shared: true }])
    expect(body.orgs.map((o: { label: string; ours: boolean; includesYou: boolean }) => [o.label, o.ours, o.includesYou])).toEqual([
      ['Claude org 1', true, true],
      ['Claude org 2', false, false],
    ])
    // v2 Phase 3: how many people carry each flag, never who.
    expect(body).not.toHaveProperty('people')
    expect(body.flagCounts).toEqual({ shared: 2, 'outside-org': 1, several: 0, 'seat-no-use': 0, 'use-no-seat': 0 })
    for (const leak of [USER_A, USER_B, TEAM_B, 'Ada', 'Bo']) expect(res.body).not.toContain(leak)
    expect(callsTo(mongoState, 'users', 'find')).toEqual([])
    expect(callsTo(mongoState, 'teamMembers', 'find')).toEqual([])
    // No hash leaves the API except the org ids the save call needs.
    const { orgs, ...rest } = body
    expect(JSON.stringify(rest)).not.toMatch(/[0-9a-f]{64}/)
    expect(orgs.map((o: { id: string }) => o.id)).toEqual([OWN, OTHER])
  })

  it('narrows to one team', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [{ teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' }]
    expect((await get('admin', `${URL}&teamId=${TEAM_A}`)).statusCode).toBe(200)
    expect((callsTo(mongoState, 'claudeEnrichment', 'find')[0][0] as { userId: unknown }).userId).toEqual({ $in: [USER_A] })
  })

  it('answers empty lists and zero counts without reading users when nothing is hashed', async () => {
    const body = (await get('admin')).json()
    expect(body).toMatchObject({
      coverage: { users: 0, hashed: 0 },
      companyOrgSet: false,
      orgs: [],
      accounts: [],
      flagCounts: { shared: 0, 'outside-org': 0, several: 0, 'seat-no-use': 0, 'use-no-seat': 0 },
    })
    expect(callsTo(mongoState, 'users', 'find')).toEqual([])
  })
})

describe('PUT /v1/dashboard/governance/claude-orgs', () => {
  const url = '/v1/dashboard/governance/claude-orgs'
  const OWN = 'c'.repeat(64)
  const send = (payload: object, role: JwtPayload['role'] = 'admin') =>
    app.inject({ method: 'PUT', url, payload, headers: auth(token({ role })) })

  it.each(['developer', 'manager'] as const)('answers 403 to a %s and writes nothing', async (role) => {
    expect((await send({ ids: [OWN] }, role)).statusCode).toBe(403)
    expect(mongoState.calls).toEqual([])
  })

  it.each([{ ids: ['x'] }, { ids: ['C'.repeat(64)] }, {}])('rejects %j with 400', async (body) => {
    expect((await send(body)).statusCode).toBe(400)
    expect(callsTo(mongoState, 'organizations', 'updateOne')).toEqual([])
  })

  it('rejects an org hash never seen in this org', async () => {
    mongoState.docs.claudeEnrichment = [{ orgId: ORG_A, claudeOrgHashes: ['d'.repeat(64)] }]
    expect((await send({ ids: [OWN] })).statusCode).toBe(400)
    expect(callsTo(mongoState, 'organizations', 'updateOne')).toEqual([])
  })

  it('sets seen hashes and audits the count only', async () => {
    mongoState.docs.claudeEnrichment = [{ orgId: ORG_A, claudeOrgHashes: [OWN] }]
    const res = await send({ ids: [OWN, OWN] })
    expect(res.json()).toEqual({ count: 1 })
    expect(callsTo(mongoState, 'claudeEnrichment', 'find')[0][0]).toEqual({ orgId: ORG_A, claudeOrgHashes: { $in: [OWN] } })
    expect(callsTo(mongoState, 'organizations', 'updateOne')).toEqual([[{ _id: ORG_A }, { $set: { ownClaudeOrgHashes: [OWN] } }]])
    const [event] = callsTo(mongoState, 'auditEvents', 'insertOne').map(([d]) => d as Record<string, unknown>)
    expect(event).toMatchObject({ action: 'org.claude_orgs', detail: { count: 1 } })
    expect(JSON.stringify(event)).not.toContain(OWN)
  })

  it('clears with an empty list', async () => {
    expect((await send({ ids: [] })).json()).toEqual({ count: 0 })
    expect(callsTo(mongoState, 'organizations', 'updateOne')).toEqual([[{ _id: ORG_A }, { $unset: { ownClaudeOrgHashes: '' } }]])
  })
})

describe('GET /v1/dashboard/governance/setup-checks', () => {
  const URL = range('/v1/dashboard/governance/setup-checks')
  const get = (role: JwtPayload['role'], url = URL) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  const aggregates = () => callsTo(mongoState, 'usageEvents', 'aggregate').map((c) => c[0] as Document[])
  // The setup-check read is the one with an $or; an admin's seen-models read can run before it.
  const checkMatch = () => aggregates().find((p) => p[0].$match.$or)![0].$match
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
    expect(checkMatch()).toEqual({
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
    expect(checkMatch().$or).toEqual([
      { agent: { $in: ['qwen'] } },
      { agent: 'claude', modelName: { $nin: ['claude-opus-5'] } },
    ])
  })

  it('runs no setup-check query when every agent is allowed', async () => {
    mongoState.docs.agentPolicies = ['claude', 'qwen', 'gemini', 'codex', 'copilot'].map((a) => policy(a, 'allowed'))
    mongoState.aggregates.usageEvents = [{ _id: 'claude', models: ['claude-opus-5'] }]
    const body = (await get('admin')).json()
    expect(body.rows).toEqual([])
    // Only the seen-models read.
    expect(aggregates()).toHaveLength(1)
    expect(aggregates()[0][0].$match.$or).toBeUndefined()
  })

  // `models` only so the admin's seen-models read, which the fake answers with
  // the same seed, has something to spread.
  const groups = () => [
    { _id: { userId: USER_A, agent: 'claude', modelName: 'claude-opus-5-5' }, days: 2, tokens: 50, firstDate: DATE, lastDate: DATE, models: [] },
    { _id: { userId: USER_A, agent: 'qwen', modelName: 'coder-model' }, days: 1, tokens: 10, firstDate: DATE, lastDate: DATE, models: [] },
    { _id: { userId: USER_B, agent: 'gemini', modelName: 'gemini-3' }, days: 1, tokens: 5, firstDate: DATE, lastDate: DATE, models: [] },
  ]

  it('names each row and says why it was flagged, for an admin', async () => {
    mongoState.docs.agentPolicies = [policy('claude', 'models', ['claude-opus-5']), policy('qwen', 'blocked')]
    mongoState.aggregates.usageEvents = groups()
    mongoState.docs.users = [{ _id: USER_A, orgId: ORG_A, name: 'Ada', email: 'ada@x.test' }]
    const body = (await get('admin')).json()
    expect(body.rows.map((r: { modelName: string; reason: string }) => [r.modelName, r.reason])).toEqual([
      ['claude-opus-5-5', 'model-not-listed'],
      ['coder-model', 'agent-blocked'],
      ['gemini-3', 'agent-not-set'],
    ])
    expect(body.rows[0]).toEqual({
      userId: USER_A,
      userName: 'Ada',
      userEmail: 'ada@x.test',
      teams: [],
      agent: 'claude',
      modelName: 'claude-opus-5-5',
      reason: 'model-not-listed',
    })
    expect(body.people).toBe(2)
    expect(body).not.toHaveProperty('byTeam')
    expect(body.policies[0]).toEqual({ agent: 'claude', rule: 'models', models: ['claude-opus-5'], note: null })
  })

  // v2 Phase 3: a manager learns how many people used something outside the
  // rules, never who.
  it('gives a manager a people count and no rows, without reading names', async () => {
    mongoState.docs.agentPolicies = [policy('claude', 'models', ['claude-opus-5']), policy('qwen', 'blocked')]
    mongoState.aggregates.usageEvents = groups()
    mongoState.docs.users = [
      { _id: USER_A, orgId: ORG_A, name: 'Ada', email: 'ada@x.test' },
      { _id: USER_B, orgId: ORG_A, name: 'Bo', email: 'bo@x.test' },
    ]
    const res = await get('manager')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.rows).toEqual([])
    expect(body.people).toBe(2)
    expect(body).not.toHaveProperty('byTeam')
    for (const leak of [USER_A, USER_B, 'Ada', 'Bo', 'ada@x.test', 'bo@x.test']) expect(res.body).not.toContain(leak)
    expect(callsTo(mongoState, 'users', 'find')).toEqual([])
  })

  it('answers 404 on the old /governance/violations path', async () => {
    for (const path of ['/v1/dashboard/governance/violations', '/v1/dashboard/governance/violations/count']) {
      expect((await get('admin', path.endsWith('count') ? path : range(path))).statusCode, path).toBe(404)
    }
    expect(mongoState.calls.filter((c) => c.collection !== 'auditEvents')).toEqual([])
  })

  it('limits a manager to their teams and skips the seen-models read', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
    ]
    const body = (await get('manager')).json()
    expect(aggregates()).toHaveLength(1)
    expect(aggregates()[0][0].$match.userId).toEqual({ $in: [USER_A, USER_B, ...PEERS] })
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
    expect((await send('GET', '/v1/dashboard/governance/setup-checks/count', undefined, role)).statusCode).toBe(403)
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

  it('counts setup-check groups over the last 30 days for an admin', async () => {
    mongoState.aggregates.usageEvents = [{ n: 4 }]
    expect((await send('GET', '/v1/dashboard/governance/setup-checks/count')).json()).toEqual({ count: 4 })
    const pipeline = callsTo(mongoState, 'usageEvents', 'aggregate')[0][0] as Document[]
    expect(pipeline[0].$match).toMatchObject({ orgId: ORG_A, $or: [{ agent: { $in: expect.any(Array) } }] })
    expect(pipeline.at(-1)).toEqual({ $count: 'n' })
  })
})

describe('GET /v1/dashboard/adoption/unused-seats', () => {
  const URL = '/v1/dashboard/adoption/unused-seats'
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

  // Admin only since v2 Phase 3: the rows are named.
  it.each(['developer', 'manager'] as const)('refuses a %s before reading seats', async (role) => {
    seed()
    expect((await get(role)).statusCode).toBe(403)
    expect(callsTo(mongoState, 'seats', 'find')).toEqual([])
    expect(callsTo(mongoState, 'users', 'find')).toEqual([])
  })

  it('answers 404 on the old /adoption/idle-seats path', async () => {
    expect((await get('admin', '/v1/dashboard/adoption/idle-seats')).statusCode).toBe(404)
  })

  it.each(['0', '366', '1.5', 'abc'])('rejects idleDays=%s', async (n) => {
    expect((await get('admin', `${URL}?idleDays=${n}`)).statusCode).toBe(400)
    expect(callsTo(mongoState, 'seats', 'find')).toEqual([])
  })

  it('reads only the caller org, skips seats younger than the window, defaults to 14 days', async () => {
    const res = await get('admin')
    expect(res.json()).toEqual({ idleDays: 14, rows: [], byAgent: [], totalMonthlyUsd: 0, orgSeats: 0 })
    expect(callsTo(mongoState, 'seats', 'find')[0][0]).toEqual({ orgId: ORG_A, startDate: { $lte: daysBefore(t, 13) } })
    expect(callsTo(mongoState, 'seats', 'find')[1][0]).toEqual({ orgId: ORG_A })
    // Nothing idle, so no last-used, user or team reads.
    expect(callsTo(mongoState, 'dailySnapshots', 'aggregate')).toEqual([])
    expect(callsTo(mongoState, 'users', 'find')).toEqual([])
  })

  it('lists unused seats longest unused first, counting a never-used seat from its start date', async () => {
    seed()
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [{ teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' }]
    const res = await get('admin', `${URL}?idleDays=30`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(callsTo(mongoState, 'seats', 'find')[0][0]).toMatchObject({ startDate: { $lte: daysBefore(t, 29) } })
    const [, lastUsedPipeline] = callsTo(mongoState, 'dailySnapshots', 'aggregate') as Document[][][]
    expect(lastUsedPipeline[0][0].$match).toEqual({ orgId: ORG_A, userId: { $in: [USER_A, USER_B] } })
    expect(callsTo(mongoState, 'users', 'find')[0][0]).toMatchObject({ orgId: ORG_A })

    // Name, seat and days unused only: no team, price, start date or last use.
    expect(body.rows).toEqual([
      { userId: USER_B, userName: 'Bo', agent: 'copilot', daysUnused: 41 },
      { userId: USER_A, userName: 'Ada', agent: 'claude', daysUnused: 20 },
    ])
    for (const row of body.rows) expect(Object.keys(row).sort()).toEqual(['agent', 'daysUnused', 'userId', 'userName'])
    expect(res.body).not.toContain('Platform')
    expect(body).not.toHaveProperty('byTeam')
    expect(body.byAgent).toEqual([
      { agent: 'claude', seats: 1, monthlyUsd: 30 },
      { agent: 'copilot', seats: 1, monthlyUsd: 19 },
    ])
    expect(body.totalMonthlyUsd).toBe(49)
    expect(body.orgSeats).toBe(2)
    expect(callsTo(mongoState, 'teamMembers', 'find')).toEqual([])
  })

  it('narrows an admin to one team', async () => {
    seed()
    mongoState.docs.seats.push(seatDoc(USER_C, 'gemini', daysBefore(t, 60), 20))
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
    ]
    const body = (await get('admin', `${URL}?teamId=${TEAM_A}`)).json()
    expect(body.rows.map((r: { userId: string }) => r.userId).sort()).toEqual([USER_A, USER_B].sort())
    expect(body.totalMonthlyUsd).toBe(49)
  })

  it('answers 404 to a team outside the org', async () => {
    seed()
    expect((await get('admin', `${URL}?teamId=${TEAM_B}`)).statusCode).toBe(404)
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

  it('clamps the range start to the first usage day, so All time keeps power reachable', async () => {
    mongoState.docs.dailySnapshots = [{ orgId: ORG_A, date: daysBefore(t, 2), totalTokens: 5 }]
    const res = await get('admin', `/v1/dashboard/adoption/funnel?from=2020-01-01&to=${t}`)
    expect(res.json()).toMatchObject({ from: daysBefore(t, 2), to: t, rangeDays: 3, activeDays: 2, powerDays: 3 })
    const [filter, opts] = callsTo(mongoState, 'dailySnapshots', 'find')[0] as [object, object]
    expect(filter).toEqual({ orgId: ORG_A, totalTokens: { $gt: 0 } })
    expect(opts).toMatchObject({ sort: { date: 1 }, limit: 1 })

    // A first day before `from` leaves the picked range alone.
    mongoState.docs.dailySnapshots = [{ orgId: ORG_A, date: daysBefore(t, 30), totalTokens: 5 }]
    expect((await get('admin')).json()).toMatchObject({ from, rangeDays: 7, powerDays: 5 })
  })

  it('counts the org per team of 5 or more, invites once per email, and names no one', async () => {
    mongoState.docs.teams = [
      { _id: TEAM_A, orgId: ORG_A, name: 'Platform' },
      { _id: TEAM_B, orgId: ORG_A, name: 'Web' },
    ]
    // Platform has 5 members (Ada, Bo and PEERS), Web only 3: Web gets no row.
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' },
      { teamId: TEAM_B, orgId: ORG_A, userId: USER_A, role: 'member' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
      { teamId: TEAM_B, orgId: ORG_A, userId: 'web-2', role: 'member' },
      { teamId: TEAM_B, orgId: ORG_A, userId: 'web-3', role: 'member' },
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
    expect(body.teams).toEqual([{ teamId: TEAM_A, teamName: 'Platform', ...counts(3, 2, 2, 1, 1, 1) }])
    // Cy and old@x.io are the only people in no team: under 5, so no row.
    expect(body.noTeam).toBeNull()
    expect(Object.keys(body).sort()).toEqual(['activeDays', 'from', 'noTeam', 'powerDays', 'rangeDays', 'teams', 'to', 'total'])
    for (const leak of [USER_A, USER_B, USER_C, 'Ada', 'Bo', 'Cy', 'x.io']) expect(res.body).not.toContain(leak)
  })

  it('shows No team only for 5 or more people', async () => {
    const loners = (n: number) => Array.from({ length: n }, (_, i) => row(`loner-${i}`, `Loner ${i}`, { activeDays: 5 }))
    mongoState.aggregates.users = loners(4)
    expect((await get('admin')).json().noTeam).toBeNull()
    mongoState.aggregates.users = loners(5)
    const res = await get('admin')
    expect(res.json().noTeam).toEqual(counts(5, 5, 5, 5, 5, 5))
    expect(res.body).not.toContain('loner')
    expect(res.body).not.toContain('Loner')
  })

  it('limits a manager to their teams: no No-team row, no other teams or invites', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
    ]
    mongoState.aggregates.users = [row(USER_A, 'Ada', { activeDays: 2 }), row(USER_B, 'Bo')]
    mongoState.docs.users = [{ email: 'ada@x.io' }]
    mongoState.docs.invites = [invite('x@x.io', TEAM_A, 1), invite('y@x.io', TEAM_B, 1), invite('z@x.io', null, 1)]

    const body = (await get('manager')).json()
    const [pipeline] = callsTo(mongoState, 'users', 'aggregate')[0] as Document[][]
    expect(pipeline[0].$match._id.$in.sort()).toEqual([USER_A, USER_B, ...PEERS].sort())
    expect(body.noTeam).toBeNull()
    expect(body.total).toEqual(counts(3, 2, 2, 2, 1, 0))
    expect(body.teams).toEqual([{ teamId: TEAM_A, teamName: 'Platform', ...counts(3, 2, 2, 2, 1, 0) }])
    for (const leak of [USER_A, USER_B, ...PEERS, 'Ada', 'Bo', 'x.io']) expect(JSON.stringify(body)).not.toContain(leak)
  })

  it('narrows an admin to one team, with that team only and no No-team row', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
    ]
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

describe('GET /v1/dashboard/adoption/features', () => {
  const t = today()
  const from = daysBefore(t, 6)
  const URL = `/v1/dashboard/adoption/features?from=${from}&to=${t}`
  const get = (role: JwtPayload['role'], url = URL) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  const day = (userId: string, over: Record<string, unknown> = {}) => ({ userId, orgId: ORG_A, date: t, ...over })
  const none = { mcp: 0, skills: 0, subagents: 0, plan: 0, sdk: 0 }

  it('refuses a developer before reading anything', async () => {
    expect((await get('developer')).statusCode).toBe(403)
    expect(callsTo(mongoState, 'claudeEnrichment', 'find')).toEqual([])
  })

  it.each([`?from=${from}`, `?from=${t}&to=${from}`, ''])('rejects range %s', async (q) => {
    expect((await get('admin', `/v1/dashboard/adoption/features${q}`)).statusCode).toBe(400)
  })

  it('reads the range, counts people per team of 5 or more and once in total, and names no one', async () => {
    mongoState.docs.teams = [
      { _id: TEAM_A, orgId: ORG_A, name: 'Platform' },
      { _id: TEAM_B, orgId: ORG_A, name: 'Web' },
    ]
    // Platform has 5 members (Ada, PEERS and one more), Web only 3: Web gets no row.
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' },
      { teamId: TEAM_B, orgId: ORG_A, userId: USER_A, role: 'member' },
      ...peerRows(TEAM_A),
      { teamId: TEAM_A, orgId: ORG_A, userId: 'platform-5', role: 'member' },
      { teamId: TEAM_B, orgId: ORG_A, userId: 'web-2', role: 'member' },
      { teamId: TEAM_B, orgId: ORG_A, userId: 'web-3', role: 'member' },
    ]
    mongoState.docs.claudeEnrichment = [
      day(USER_B, { toolUsage: { read: 3 } }),
      day(USER_A, { mcpUsage: { github: 2 }, toolUsage: { skill: 1 } }),
      day(USER_A, { date: from, toolUsage: { agent: 1 }, entrypointCounts: { cli: 4 } }),
    ]
    mongoState.docs.users = [
      { _id: USER_A, name: 'Ada' },
      { _id: USER_B, name: 'Bo' },
    ]

    const res = await get('admin')
    const body = res.json()
    const [filter, opts] = callsTo(mongoState, 'claudeEnrichment', 'find')[0] as [object, { projection: object }]
    expect(filter).toEqual({ orgId: ORG_A, date: { $gte: from, $lte: t } })
    expect(Object.keys(opts.projection)).not.toContain('accountHashes')
    // Names are not even read.
    expect(callsTo(mongoState, 'users', 'find')[0][1]).toEqual({ projection: { _id: 1 } })
    const ada = { users: 1, used: { ...none, mcp: 1, skills: 1, subagents: 1 }, sdkKnown: 1 }
    expect(body.total).toEqual({ users: 2, used: { ...none, mcp: 1, skills: 1, subagents: 1 }, sdkKnown: 1 })
    expect(body.teams).toEqual([{ teamId: TEAM_A, teamName: 'Platform', ...ada }])
    // Bo alone in no team: under 5, so no row.
    expect(body.noTeam).toBeNull()
    expect(Object.keys(body).sort()).toEqual(['from', 'noTeam', 'teams', 'to', 'total'])
    for (const leak of [USER_A, USER_B, 'Ada', 'Bo']) expect(res.body).not.toContain(leak)
  })

  it('shows No team only for 5 or more people', async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `loner-${i}`)
    const seedLoners = (n: number) => {
      mongoState.docs.claudeEnrichment = ids(n).map((id) => day(id))
      mongoState.docs.users = ids(n).map((_id) => ({ _id, name: `Loner ${_id}` }))
    }
    seedLoners(4)
    expect((await get('admin')).json().noTeam).toBeNull()
    seedLoners(5)
    const res = await get('admin')
    expect(res.json().noTeam).toEqual({ users: 5, used: none, sdkKnown: 0 })
    expect(res.body).not.toContain('loner')
  })

  it('limits a manager to their teams and names no one', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
    ]
    mongoState.docs.claudeEnrichment = [day(USER_A), day(USER_B)]
    mongoState.docs.users = [
      { _id: USER_A, name: 'Ada' },
      { _id: USER_B, name: 'Bo' },
    ]

    const res = await get('manager')
    const body = res.json()
    const [filter] = callsTo(mongoState, 'claudeEnrichment', 'find')[0] as [{ userId: { $in: string[] } }]
    expect(filter.userId.$in.sort()).toEqual([USER_A, USER_B, ...PEERS].sort())
    expect(body.noTeam).toBeNull()
    expect(body.teams).toEqual([{ teamId: TEAM_A, teamName: 'Platform', users: 2, used: none, sdkKnown: 0 }])
    for (const leak of [USER_A, USER_B, ...PEERS, 'Ada', 'Bo']) expect(res.body).not.toContain(leak)
  })

  it('narrows an admin to one team with no No-team row', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
    ]
    mongoState.docs.claudeEnrichment = [day(USER_A)]
    mongoState.docs.users = [{ _id: USER_A, name: 'Ada' }]
    const body = (await get('admin', `${URL}&teamId=${TEAM_A}`)).json()
    expect(body.noTeam).toBeNull()
    expect(body.teams).toEqual([{ teamId: TEAM_A, teamName: 'Platform', users: 1, used: none, sdkKnown: 0 }])
  })

  it('answers an empty matrix without reading users when no one used Claude Code', async () => {
    const body = (await get('admin')).json()
    expect(body).toMatchObject({ from, to: t, teams: [], noTeam: null, total: { users: 0, sdkKnown: 0 } })
    expect(callsTo(mongoState, 'users', 'find')).toEqual([])
  })

  it('answers 404 to a team outside the org before reading usage', async () => {
    expect((await get('admin', `${URL}&teamId=${TEAM_B}`)).statusCode).toBe(404)
    expect(callsTo(mongoState, 'claudeEnrichment', 'find')).toEqual([])
  })
})

describe('GET /v1/dashboard/adoption/onboarding', () => {
  const t = today()
  const from = daysBefore(t, 29)
  const URL = `/v1/dashboard/adoption/onboarding?from=${from}&to=${t}`
  const get = (role: JwtPayload['role'], url = URL) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  const row = (userId: string, name: string, firstSync: string | null) => ({
    userId, name, createdAt: new Date(`${daysBefore(t, 50)}T09:00:00Z`), hasDevice: true, firstSync, lastSync: t, activeDays: 1,
  })
  const counts = (cohort: number, onboarded: number, windowEnded: number, inProgress: number, noFeatureData: number) =>
    ({ cohort, onboarded, windowEnded, inProgress, noFeatureData })
  const U3 = 'u3-onboarding'
  const U4 = 'u4-onboarding'
  const U5 = 'u5-onboarding'
  // Day n (1-based) of a window that starts `ago` days before today.
  const on = (ago: number, n: number) => daysBefore(t, ago - (n - 1))
  const seed = () => {
    mongoState.aggregates.users = [
      row(USER_A, 'Ada', daysBefore(t, 25)), // onboarded
      row(USER_B, 'Bo', daysBefore(t, 20)), // window ended: one day only
      row(U3, 'Cy', daysBefore(t, 3)), // in progress
      row(U4, 'Dee', daysBefore(t, 40)), // started before the range
      row(U5, 'Eve', daysBefore(t, 22)), // tokens, no Claude Code day
      row('u6-onboarding', 'Fay', null), // never synced: not in the cohort
    ]
    mongoState.docs.dailySnapshots = [
      ...[1, 2, 8, 9].map((n) => ({ userId: USER_A, date: on(25, n) })),
      { userId: USER_B, date: on(20, 1) },
      { userId: U3, date: on(3, 1) },
      ...[1, 2, 8, 9].map((n) => ({ userId: U5, date: on(22, n) })),
    ]
    mongoState.docs.claudeEnrichment = [
      { userId: USER_A, orgId: ORG_A, date: on(25, 1), mcpUsage: { github: 1 }, toolUsage: { agent: 1 } },
      { userId: USER_B, orgId: ORG_A, date: on(20, 1), mcpUsage: { github: 1 } },
      { userId: U3, orgId: ORG_A, date: on(3, 1), toolUsage: { skill: 1 } },
    ]
  }

  it('refuses a developer before reading anything', async () => {
    expect((await get('developer')).statusCode).toBe(403)
    expect(callsTo(mongoState, 'users', 'aggregate')).toEqual([])
  })

  // A fifth person in range, so the cohort reaches MIN_GROUP_SIZE.
  const U7 = 'u7-onboarding'
  const seedFive = () => {
    seed()
    mongoState.aggregates.users.push(row(U7, 'Gus', daysBefore(t, 10))) // tokens, no Claude Code day
    mongoState.docs.dailySnapshots.push({ userId: U7, date: on(10, 1) })
  }
  const NAMES = ['Ada', 'Bo', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus']
  const IDS = [USER_A, USER_B, U3, U4, U5, 'u6-onboarding', U7]

  it('hides every count for a cohort of 4', async () => {
    seed()
    const res = await get('admin')
    const body = res.json()
    expect(body).toMatchObject({ from, to: t, activeDaysPerWeek: 2, minFeatures: 2, minForPercent: 5 })
    expect(body.total).toBeNull()
    expect(body.noTeam).toBeNull()
    expect(body.teams).toEqual([])
  })

  it('scores a cohort of 5 whose first sync is in range, counts only', async () => {
    seedFive()
    const res = await get('admin')
    const body = res.json()
    expect(body.total).toEqual(counts(5, 1, 1, 1, 2))
    expect(body.noTeam).toEqual(counts(5, 1, 1, 1, 2))
    expect(Object.keys(body).sort()).toEqual(
      ['activeDaysPerWeek', 'from', 'minFeatures', 'minForPercent', 'noTeam', 'teams', 'to', 'total'],
    )
    for (const leak of [...NAMES, ...IDS]) expect(res.body).not.toContain(leak)

    const [filter] = callsTo(mongoState, 'dailySnapshots', 'find')[0] as [Record<string, unknown>]
    expect(filter).toMatchObject({ orgId: ORG_A, date: { $gte: daysBefore(t, 25), $lte: daysBefore(t, -13) }, totalTokens: { $gt: 0 } })
    expect((filter.userId as { $in: string[] }).$in.sort()).toEqual([USER_A, USER_B, U3, U5, U7].sort())
  })

  it('counts a team only when its cohort is 5 or more', async () => {
    seedFive()
    mongoState.docs.teams = [
      { _id: TEAM_A, orgId: ORG_A, name: 'Platform' },
      { _id: TEAM_B, orgId: ORG_A, name: 'Web' },
    ]
    // Platform: the whole cohort. Web: 3 of them, plus 2 who started before the range.
    mongoState.docs.teamMembers = [
      ...[USER_A, USER_B, U3, U5, U7].map((userId) => ({ teamId: TEAM_A, orgId: ORG_A, userId, role: 'member' })),
      ...[USER_A, USER_B, U3, U4, 'u6-onboarding'].map((userId) => ({ teamId: TEAM_B, orgId: ORG_A, userId, role: 'member' })),
    ]
    const res = await get('manager')
    const body = res.json()
    expect(body.teams).toEqual([{ teamId: TEAM_A, teamName: 'Platform', ...counts(5, 1, 1, 1, 2) }])
    expect(body.noTeam).toBeNull()
    for (const leak of [...NAMES, ...IDS]) expect(res.body).not.toContain(leak)
  })

  it('leaves No team out for a team filter', async () => {
    seedFive()
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [USER_A, USER_B, U3, U5, U7].map((userId) => ({ teamId: TEAM_A, orgId: ORG_A, userId, role: 'member' }))
    const body = (await get('admin', `${URL}&teamId=${TEAM_A}`)).json()
    expect(body.teams).toEqual([{ teamId: TEAM_A, teamName: 'Platform', ...counts(5, 1, 1, 1, 2) }])
    expect(body.noTeam).toBeNull()
  })

  it('reads no usage when nobody started in range', async () => {
    mongoState.aggregates.users = [row(USER_A, 'Ada', daysBefore(t, 40))]
    const body = (await get('admin')).json()
    expect(body.total).toBeNull()
    expect(callsTo(mongoState, 'dailySnapshots', 'find')).toEqual([])
  })

  it('answers 404 to a team outside the org before reading people', async () => {
    expect((await get('admin', `${URL}&teamId=${TEAM_B}`)).statusCode).toBe(404)
    expect(callsTo(mongoState, 'users', 'aggregate')).toEqual([])
  })
})

describe('GET /v1/dashboard/adoption/practices', () => {
  const t = today()
  const from = daysBefore(t, 6)
  const URL = `/v1/dashboard/adoption/practices?from=${from}&to=${t}`
  const get = (role: JwtPayload['role'], url = URL) =>
    app.inject({ method: 'GET', url, headers: auth(token({ role })) })
  const U3 = 'u3-practices'
  const U4 = 'u4-practices'
  const day = (userId: string, date: string, over: Record<string, unknown> = {}) => ({ userId, orgId: ORG_A, date, ...over })
  // USER_A: 3 days, MCP every day. The others: 1 day each, no MCP. USER_B has the most tokens.
  // USER_A and USER_B set "happy to help"; U3 and U4 did not.
  const seed = () => {
    mongoState.docs.claudeEnrichment = [
      ...[0, 1, 2].map((n) => day(USER_A, daysBefore(t, n), { mcpUsage: { github: 1 } })),
      day(USER_B, t),
      day(U3, t),
      day(U4, t, { toolUsage: { exitplanmode: 1 } }),
    ]
    mongoState.docs.users = [USER_A, USER_B, U3, U4].map((_id) => ({ _id, name: `Name-${_id}`, helpVolunteer: _id === USER_A || _id === USER_B }))
    mongoState.aggregates.usageEvents = [
      { _id: USER_A, tokens: 100, read: 95, cacheable: 100 },
      { _id: USER_B, tokens: 900, read: 50, cacheable: 100 },
      { _id: U3, tokens: 10, read: 60, cacheable: 100 },
    ]
    mongoState.aggregates.claudeEnrichment = [{ _id: USER_A, servers: ['github', 'linear'] }]
  }
  // MIN_QUARTILE_PEOPLE is 17, so a comparison needs seed()'s four plus 13 more.
  // The top quartile is then 5 people, one of each kind below plus the seed's own.
  const TOPS = [1, 2, 3, 4].map((n) => `top${n}-practices`) // like USER_A: 3 days, MCP, 95% cache
  const HEAVY = [1, 2, 3, 4].map((n) => `heavy${n}-practices`) // like USER_B: 1 day, 900 tokens
  const PLANNERS = [1, 2, 3, 4].map((n) => `plan${n}-practices`) // like U4: 1 day, plan mode
  const QUIET = 'quiet-practices' // 1 day, nothing else
  const EVERYONE = [USER_A, USER_B, U3, U4, ...TOPS, ...HEAVY, ...PLANNERS, QUIET]
  const crowd = () => {
    seed()
    mongoState.docs.claudeEnrichment.push(
      ...TOPS.flatMap((id) => [0, 1, 2].map((n) => day(id, daysBefore(t, n), { mcpUsage: { github: 1 } }))),
      ...HEAVY.map((id) => day(id, t)),
      ...PLANNERS.map((id) => day(id, t, { toolUsage: { exitplanmode: 1 } })),
      day(QUIET, t),
    )
    mongoState.docs.users = EVERYONE.map((_id) => ({ _id, name: `Name-${_id}` }))
    mongoState.aggregates.usageEvents.push(
      ...TOPS.map((_id) => ({ _id, tokens: 100, read: 95, cacheable: 100 })),
      // Two at 50% and two at 60%, so the rest's median cache stays 55.
      ...HEAVY.map((_id, i) => ({ _id, tokens: 900, read: i < 2 ? 50 : 60, cacheable: 100 })),
    )
    mongoState.aggregates.claudeEnrichment.push(...TOPS.map((_id) => ({ _id, servers: ['github', 'linear'] })))
  }

  it('refuses a developer before reading anything', async () => {
    expect((await get('developer')).statusCode).toBe(403)
    expect(callsTo(mongoState, 'claudeEnrichment', 'find')).toEqual([])
  })

  it.each([`?from=${from}`, `?from=${from}&to=${t}&rankBy=cost`, `?from=${from}&to=${t}&rankBy=score`])('rejects query %s', async (q) => {
    expect((await get('admin', `/v1/dashboard/adoption/practices${q}`)).statusCode).toBe(400)
  })

  it('compares nothing below 17 people and lists only volunteers', async () => {
    const more = Array.from({ length: 13 }, (_, i) => `few${i}-practices`)
    mongoState.docs.claudeEnrichment = [day(USER_A, t), day(USER_A, from), day(USER_B, t), day(U3, t), ...more.map((id) => day(id, t))]
    // Bo has the most days after Ada, but did not volunteer.
    mongoState.docs.users = [
      { _id: USER_A, name: 'Ada', helpVolunteer: true },
      { _id: USER_B, name: 'Bo Nonvolunteer', helpVolunteer: false },
      { _id: U3, name: 'Cy Nonvolunteer' },
      ...more.map((_id) => ({ _id, name: _id })),
    ]
    const res = await get('admin')
    const body = res.json()
    expect(body).toMatchObject({ population: 16, minPopulation: 17, top: null, rest: null, tips: [] })
    expect(body).not.toHaveProperty('champions')
    expect(body.volunteers).toEqual([
      { teamId: null, teamName: 'No team', volunteers: [{ userId: USER_A, name: 'Ada', canHelpWith: [] }] },
    ])
    for (const leak of ['Nonvolunteer', USER_B, U3, ...more]) expect(res.body).not.toContain(leak)
  })

  it('answers empty with no Claude Code users and reads no tokens', async () => {
    const body = (await get('admin')).json()
    expect(body).toMatchObject({ population: 0, top: null, volunteers: [] })
    expect(callsTo(mongoState, 'usageEvents', 'aggregate')).toEqual([])
  })

  it('ranks by active days, compares the groups, fires tips, and names no one', async () => {
    crowd()
    const res = await get('admin')
    const body = res.json()
    expect(body.population).toBe(17)
    expect(body.top).toEqual({
      users: 5,
      uses: { mcp: 1, skills: 0, subagents: 0, plan: 0 },
      dayShare: { mcp: 1, skills: 0, subagents: 0, plan: 0 },
      mcpServers: 2,
      cacheHitRate: 95,
    })
    expect(body.rest).toMatchObject({ users: 12, mcpServers: 0, cacheHitRate: 55 })
    expect(body.rest.uses.plan).toBeCloseTo(5 / 12)
    expect(body.tips).toEqual([{ id: 'mcp', gap: 1 }, { id: 'cache', gap: 0.4 }])
    // The comparison names no one; only volunteers carry names.
    const groups = JSON.stringify({ top: body.top, rest: body.rest, tips: body.tips })
    for (const id of EVERYONE) expect(groups).not.toContain(id)
    expect(groups).not.toContain('Name-')

    const [pipeline] = callsTo(mongoState, 'usageEvents', 'aggregate')[0] as Document[][]
    expect(pipeline[0].$match).toMatchObject({ orgId: ORG_A, agent: 'claude', date: { $gte: from, $lte: t } })
    expect(pipeline[0].$match.userId.$in.sort()).toEqual([...EVERYONE].sort())
    expect(callsTo(mongoState, 'dailySnapshots', 'find')).toEqual([])
  })

  it('ranks by Claude tokens when asked', async () => {
    crowd()
    const body = (await get('admin', `${URL}&rankBy=tokens`)).json()
    expect(body.rankBy).toBe('tokens')
    // USER_B and HEAVY are on top now: no MCP, median 50% cache.
    expect(body.top).toMatchObject({ users: 5, mcpServers: 0, cacheHitRate: 50 })
    expect(body.top.uses.mcp).toBe(0)
  })

  it('limits a manager to their teams', async () => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'manager' },
      { teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
    ]
    const res = await get('manager')
    const [filter] = callsTo(mongoState, 'claudeEnrichment', 'find')[0] as [{ userId: { $in: string[] } }]
    expect(filter.userId.$in.sort()).toEqual([USER_A, USER_B, ...PEERS].sort())
    expect(res.json().population).toBe(0)
  })

  describe('recommended setup (R2 D5)', () => {
    // seed() is below MIN_QUARTILE_PEOPLE, so there is no top quartile here: the
    // reference group is the volunteers, USER_A and USER_B.
    const servers = () => {
      mongoState.aggregates.claudeEnrichment = [
        { _id: USER_A, servers: ['github', 'linear', 'plugin_sp_x'] },
        { _id: USER_B, servers: ['github', 'plugin_sp_x'] },
        { _id: U3, servers: ['github'] },
      ]
    }

    it('lists servers shared by the top quartile plus volunteers, counts only', async () => {
      seed()
      servers()
      const res = await get('admin')
      const body = res.json()
      expect(body.setup).toEqual([
        {
          teamId: null,
          teamName: 'Whole org',
          groupSize: 2,
          reason: 'ok',
          items: [
            { key: 'github', source: 'local', topUsers: 2, teamUsers: 3, approved: null },
            { key: 'plugin_sp_x', source: 'plugin', topUsers: 2, teamUsers: 2, approved: null },
          ],
        },
      ])
      for (const id of [USER_A, USER_B, U3, U4]) expect(JSON.stringify(body.setup)).not.toContain(id)
    })

    it('badges unapproved servers for admins only, once the org has an approval', async () => {
      seed()
      servers()
      mongoState.docs.mcpApprovals = [{ _id: 'x', orgId: ORG_A, server: 'github' }]
      const admin = (await get('admin')).json()
      expect(admin.setup[0].items.map((i: { key: string; approved: boolean }) => [i.key, i.approved])).toEqual([
        ['github', true],
        ['plugin_sp_x', false],
      ])
      expect(callsTo(mongoState, 'mcpApprovals', 'find')[0][0]).toEqual({ orgId: ORG_A })
    })

    it('reads no approvals for a manager and names the scope card for them', async () => {
      seed()
      servers()
      mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
      // PEERS bring the team to MIN_GROUP_SIZE; they have no Claude Code days.
      mongoState.docs.teamMembers = [USER_A, USER_B, U3, U4, ...PEERS].map((userId) => ({ teamId: TEAM_A, orgId: ORG_A, userId, role: 'member' }))
      const body = (await get('manager')).json()
      expect(callsTo(mongoState, 'mcpApprovals', 'find')).toEqual([])
      expect(body.setup.map((c: { teamName: string }) => c.teamName)).toEqual(['All your teams', 'Platform'])
      expect(body.setup[1].items[0]).toMatchObject({ key: 'github', approved: null })
    })

    // v2 rule 2: no per-team counts for a team under MIN_GROUP_SIZE (5).
    it('gives no card to a team with fewer than 5 members', async () => {
      seed()
      servers()
      mongoState.docs.teams = [
        { _id: TEAM_A, orgId: ORG_A, name: 'Platform' },
        { _id: TEAM_B, orgId: ORG_A, name: 'Tiny' },
      ]
      mongoState.docs.teamMembers = [
        ...[USER_A, USER_B, U3, U4, PEERS[0]].map((userId) => ({ teamId: TEAM_A, orgId: ORG_A, userId, role: 'member' })),
        ...[USER_A, USER_B, U3, U4].map((userId) => ({ teamId: TEAM_B, orgId: ORG_A, userId, role: 'member' })),
      ]
      const body = (await get('admin')).json()
      expect(body.setup.map((c: { teamName: string }) => c.teamName)).toEqual(['Whole org', 'Platform'])
      expect(JSON.stringify(body.setup)).not.toContain(TEAM_B)
    })

    it('says the group is too small with one reference person, and skips the scope card for a team filter', async () => {
      seed()
      servers()
      mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
      // Five members, none of them volunteers, and no top quartile: an empty reference group.
      mongoState.docs.teamMembers = [U3, U4, ...PEERS].map((userId) => ({ teamId: TEAM_A, orgId: ORG_A, userId, role: 'member' }))
      const body = (await get('admin', `${URL}&teamId=${TEAM_A}`)).json()
      expect(body.setup).toEqual([{ teamId: TEAM_A, teamName: 'Platform', groupSize: 0, reason: 'smallGroup', items: [] }])
    })
  })

  describe('volunteers (v2 Phase 2)', () => {
    // Only USER_A volunteers. USER_B has the most tokens and is not named.
    const teamOfFour = () => {
      seed()
      for (const u of mongoState.docs.users) u.helpVolunteer = u._id === USER_A
      mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
      // PEERS bring the team to MIN_GROUP_SIZE; they have no Claude Code days.
      mongoState.docs.teamMembers = [USER_A, USER_B, U3, U4, ...PEERS].map((userId) => ({
        teamId: TEAM_A, orgId: ORG_A, userId, role: userId === USER_A ? 'manager' : 'member',
      }))
    }
    const names = (body: { volunteers: { teamName: string; volunteers: { name: string }[] }[] }) =>
      Object.fromEntries(body.volunteers.map((t) => [t.teamName, t.volunteers.map((v) => v.name)]))
    const others = [USER_B, U3, U4, `Name-${USER_B}`, `Name-${U3}`, `Name-${U4}`]

    it('names only the volunteers per team, whatever the ranking, and skips groups with none', async () => {
      teamOfFour()
      for (const url of [URL, `${URL}&rankBy=tokens`]) {
        const res = await get('admin', url)
        const body = res.json()
        // No team has nobody, so it has no group.
        expect(names(body)).toEqual({ Platform: [`Name-${USER_A}`] })
        expect(body.volunteers[0]).toEqual({
          teamId: TEAM_A,
          teamName: 'Platform',
          volunteers: [{ userId: USER_A, name: `Name-${USER_A}`, canHelpWith: ['mcp'] }],
        })
        for (const leak of others) expect(res.body).not.toContain(leak)
      }
      expect(callsTo(mongoState, 'users', 'find')[0][1]).toEqual({ projection: { name: 1, helpVolunteer: 1 } })
    })

    it('names the same volunteers to a manager as to an admin', async () => {
      teamOfFour()
      const res = await get('manager')
      expect(names(res.json())).toEqual({ Platform: [`Name-${USER_A}`] })
      for (const leak of others) expect(res.body).not.toContain(leak)
    })

    it('lists nobody when nobody volunteered', async () => {
      teamOfFour()
      for (const u of mongoState.docs.users) u.helpVolunteer = false
      const res = await get('admin')
      expect(res.json().volunteers).toEqual([])
      expect(res.body).not.toContain('Name-')
    })

    it('narrows to the filtered team with no No-team group', async () => {
      teamOfFour()
      const body = (await get('admin', `${URL}&teamId=${TEAM_A}`)).json()
      expect(body.volunteers.map((t: { teamId: string }) => t.teamId)).toEqual([TEAM_A])
    })
  })

  it('answers 404 to a team outside the org before reading usage', async () => {
    expect((await get('admin', `${URL}&teamId=${TEAM_B}`)).statusCode).toBe(404)
    expect(callsTo(mongoState, 'claudeEnrichment', 'find')).toEqual([])
  })
})

describe('audit log (R1 B8)', () => {
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    role: JwtPayload['role'] = 'admin',
  ) => app.inject({ method, url, payload, headers: auth(token({ role })) })
  const actions = () => mongoCalls('auditEvents', 'insertOne').map(([doc]) => doc as Record<string, unknown>)
  const views = () =>
    mongoCalls('auditEvents', 'updateOne').map(([filter, update]): Record<string, unknown> => ({
      _id: (filter as { _id: string })._id,
      ...((update as { $setOnInsert: Record<string, unknown> }).$setOnInsert),
    }))
  const teamOf = (managerRole: 'manager' | 'member' = 'manager') => {
    mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
    mongoState.docs.teamMembers = [
      { _id: `${TEAM_A}:${USER_A}`, teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: managerRole },
      { _id: `${TEAM_A}:${USER_B}`, teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'member' },
      ...peerRows(TEAM_A),
    ]
  }

  describe('devices and invites', () => {
    it('records device.approve without the verification code', async () => {
      mongoState.docs.users = [{ _id: USER_A, email: 'dev@example.com' }]
      mongoState.docs.pendingDevices = [{ _id: 'pending-1', hostname: 'laptop.local', platform: 'darwin' }]
      const res = await call('POST', '/v1/auth/approve-device', { code: 'ABC123' }, 'developer')
      expect(res.statusCode).toBe(200)
      const [e] = actions()
      expect(e).toMatchObject({
        action: 'device.approve',
        actorId: USER_A,
        actorRole: 'developer',
        target: { type: 'user', id: USER_A, label: 'dev@example.com' },
        detail: { hostname: 'laptop.local', platform: 'darwin', pendingId: 'pending-1' },
      })
      expect(JSON.stringify(e)).not.toContain('ABC123')
    })

    it('records nothing for a code that does not match', async () => {
      mongoState.docs.users = [{ _id: USER_A, email: 'dev@example.com' }]
      expect((await call('POST', '/v1/auth/approve-device', { code: 'ABC123' }, 'developer')).statusCode).toBe(400)
      expect(actions()).toEqual([])
    })

    it('records device.revoke with owner and hostname, and nothing for a 404', async () => {
      expect((await call('POST', '/v1/auth/admin/devices/revoke', { deviceId: DEVICE_A })).statusCode).toBe(404)
      expect(actions()).toEqual([])

      mongoState.docs.devices = [{ _id: DEVICE_A, userId: USER_B, hostname: 'laptop.local' }]
      mongoState.docs.users = [{ _id: USER_B, orgId: ORG_A }]
      expect((await call('POST', '/v1/auth/admin/devices/revoke', { deviceId: DEVICE_A })).statusCode).toBe(200)
      expect(actions()).toEqual([
        expect.objectContaining({
          action: 'device.revoke',
          target: { type: 'device', id: DEVICE_A, label: 'laptop.local' },
          detail: { ownerId: USER_B, hostname: 'laptop.local' },
        }),
      ])
    })

    it('records device.self_revoke with the device token as actor', async () => {
      liveDeviceToken()
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/revoke-device',
        headers: auth(token({ role: 'device', deviceId: DEVICE_A })),
      })
      expect(res.statusCode).toBe(200)
      expect(actions()).toEqual([
        expect.objectContaining({ action: 'device.self_revoke', actorRole: 'device', target: { type: 'device', id: DEVICE_A, label: null } }),
      ])
    })

    it('records user.create, and nothing for another org', async () => {
      expect((await call('POST', '/v1/auth/admin/users', { email: 'x@example.com', name: 'X', orgId: ORG_B })).statusCode).toBe(403)
      expect(actions()).toEqual([])
      expect((await call('POST', '/v1/auth/admin/users', { email: 'X@example.com', name: 'X' })).statusCode).toBe(200)
      expect(actions()[0]).toMatchObject({ action: 'user.create', detail: { email: 'x@example.com', role: 'developer' } })
    })

    it('records invite.create with the role and never the token', async () => {
      const res = await call('POST', '/v1/auth/admin/invites', { email: 'new@example.com', role: 'manager' })
      expect(res.statusCode).toBe(200)
      const [e] = actions()
      expect(e).toMatchObject({
        action: 'invite.create',
        target: { type: 'invite', id: res.json().inviteId, label: 'new@example.com' },
        detail: { role: 'manager' },
      })
      expect(JSON.stringify(e)).not.toContain(res.json().token)
    })

    it('records nothing when the invitee already has an account', async () => {
      mongoState.docs.users = [{ _id: USER_B, email: 'new@example.com' }]
      expect((await call('POST', '/v1/auth/admin/invites', { email: 'new@example.com' })).statusCode).toBe(409)
      expect(actions()).toEqual([])
    })

    it('records one invite.bulk event per upload, with no tokens', async () => {
      const res = await call('POST', '/v1/auth/admin/invites/bulk', {
        rows: [{ email: 'a@example.com' }, { email: 'b@example.com', role: 'manager' }, { email: 'not-an-email' }],
      })
      expect(res.statusCode).toBe(200)
      const events = actions()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        action: 'invite.bulk',
        detail: {
          created: [
            { email: 'a@example.com', role: 'developer', team: null },
            { email: 'b@example.com', role: 'manager', team: null },
          ],
          failed: 1,
        },
      })
      const tokens = res.json().results.filter((r: { ok: boolean }) => r.ok).map((r: { token: string }) => r.token)
      for (const t of tokens) expect(JSON.stringify(events)).not.toContain(t)
    })

    it('records invite.accept with the new user as actor, after the transaction', async () => {
      mongoState.docs.invites = [{ _id: 'invite-1', orgId: ORG_A, email: 'a@b.c', role: 'manager', teamId: TEAM_A }]
      mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
      const res = await app.inject({ method: 'POST', url: '/v1/auth/invites/accept', payload: { token: 'good-token', name: 'New' } })
      expect(res.statusCode).toBe(200)
      expect(actions()).toEqual([
        expect.objectContaining({
          action: 'invite.accept',
          actorId: res.json().userId,
          actorRole: 'manager',
          orgId: ORG_A,
          detail: { role: 'manager', teamId: TEAM_A },
        }),
      ])
      expect(JSON.stringify(actions())).not.toContain('good-token')
    })

    it('records org.bootstrap with the new admin as actor', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/admin/bootstrap',
        payload: { orgName: 'Acme', orgSlug: 'acme', email: 'boss@acme.dev', name: 'Boss' },
      })
      expect(res.statusCode).toBe(200)
      expect(actions()[0]).toMatchObject({
        action: 'org.bootstrap',
        actorId: res.json().userId,
        actorRole: 'admin',
        orgId: res.json().orgId,
        detail: { orgName: 'Acme' },
      })
    })
  })

  describe('teams', () => {
    it('records team.create with the admin as actor', async () => {
      const res = await call('POST', '/v1/dashboard/teams', { name: 'Platform' })
      expect(res.statusCode).toBe(201)
      expect(actions()).toEqual([
        expect.objectContaining({
          orgId: ORG_A,
          kind: 'action',
          action: 'team.create',
          actorId: USER_A,
          actorRole: 'admin',
          target: { type: 'team', id: res.json().id, label: 'Platform' },
          count: 1,
        }),
      ])
    })

    it('records team.member_set with the role, and nothing for a 404 or a 403', async () => {
      const url = `/v1/dashboard/teams/${TEAM_A}/members/${USER_B}`
      expect((await call('PUT', url, { role: 'manager' })).statusCode).toBe(404)
      teamOf()
      mongoState.docs.users = [{ _id: USER_B, orgId: ORG_A, name: 'Priya' }]
      expect((await call('PUT', url, { role: 'manager' }, 'manager')).statusCode).toBe(403)
      expect(actions()).toEqual([])

      expect((await call('PUT', url, { role: 'manager' })).statusCode).toBe(200)
      expect(actions()[0]).toMatchObject({
        action: 'team.member_set',
        target: { type: 'team', id: TEAM_A, label: 'Platform' },
        detail: { userId: USER_B, userName: 'Priya', role: 'manager' },
      })
    })

    it('records rename, delete and member removal', async () => {
      teamOf()
      await call('PATCH', `/v1/dashboard/teams/${TEAM_A}`, { name: 'Core' })
      await call('DELETE', `/v1/dashboard/teams/${TEAM_A}/members/${USER_B}`)
      await call('DELETE', `/v1/dashboard/teams/${TEAM_A}`)
      expect(actions().map((e) => [e.action, e.target])).toEqual([
        ['team.rename', { type: 'team', id: TEAM_A, label: 'Core' }],
        ['team.member_remove', { type: 'team', id: TEAM_A, label: null }],
        ['team.delete', { type: 'team', id: TEAM_A, label: 'Platform' }],
      ])
    })
  })

  describe('seats', () => {
    const url = `/v1/dashboard/seats/${USER_B}/claude`

    it('records seat.set after the transaction, never inside it', async () => {
      mongoState.docs.users = [{ _id: USER_B, orgId: ORG_A, email: 'b@example.com' }]
      expect((await call('PUT', url, { monthlyPriceUsd: 20, startDate: DATE })).statusCode).toBe(200)
      const ops = mongoState.calls.map((c) => `${c.collection}.${c.op}`)
      expect(ops.indexOf('auditEvents.insertOne')).toBeGreaterThan(ops.indexOf('seats.updateOne'))
      expect(actions()[0]).toMatchObject({
        action: 'seat.set',
        target: { type: 'seat', id: `${USER_B}:claude`, label: 'b@example.com' },
        detail: { userId: USER_B, agent: 'claude', monthlyPriceUsd: 20, startDate: DATE },
      })
    })

    it('a failed audit write neither rolls back the seat nor fails the request', async () => {
      mongoState.docs.users = [{ _id: USER_B, orgId: ORG_A, email: 'b@example.com' }]
      mongoState.failOn = 'auditEvents.insertOne'
      const logged = vi.spyOn(app.log, 'error')
      const res = await call('PUT', url, { monthlyPriceUsd: 20, startDate: DATE })
      expect(res.statusCode).toBe(200)
      expect(mongoState.calls.some((c) => c.op === 'rollback')).toBe(false)
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ event: expect.objectContaining({ action: 'seat.set', actorId: USER_A }) }),
        'audit_write_failed',
      )
    })

    it('records seat.remove, and nothing for a seat that is not there', async () => {
      expect((await call('DELETE', url)).statusCode).toBe(404)
      expect(actions()).toEqual([])
      mongoState.docs.seats = [{ _id: `${USER_B}:claude` }]
      expect((await call('DELETE', url)).statusCode).toBe(200)
      expect(actions()[0]).toMatchObject({ action: 'seat.remove', detail: { userId: USER_B, agent: 'claude' } })
    })

    it('records seat.assign_all with the count created', async () => {
      mongoState.docs.users = [{ _id: USER_B }]
      mongoState.bulk = { upsertedCount: 1, matchedCount: 0 }
      const res = await call('POST', '/v1/dashboard/seats/assign-all', { agent: 'claude', monthlyPriceUsd: 20, startDate: DATE })
      expect(res.statusCode).toBe(200)
      expect(actions()[0]).toMatchObject({ action: 'seat.assign_all', detail: { agent: 'claude', created: 1 } })
    })
  })

  describe('budget alerts', () => {
    it('records alert.create with the parsed body', async () => {
      const res = await call('POST', '/v1/dashboard/budget-alerts', { monthlyLimitUsd: 500 })
      expect(res.statusCode).toBe(201)
      expect(actions()[0]).toMatchObject({
        action: 'alert.create',
        target: { type: 'alert', id: res.json().id },
        detail: { monthlyLimitUsd: 500, type: 'api-spend' },
      })
    })

    it('records alert.update with the patch, and nothing for a 404 delete', async () => {
      expect((await call('DELETE', `/v1/dashboard/budget-alerts/${ALERT_A}`)).statusCode).toBe(404)
      expect(actions()).toEqual([])
      mongoState.docs.budgetAlerts = [{ _id: ALERT_A, orgId: ORG_A, type: 'api-spend', monthlyLimitMicros: 1 }]
      expect((await call('PATCH', `/v1/dashboard/budget-alerts/${ALERT_A}`, { threshold: 0.5 })).statusCode).toBe(200)
      expect((await call('DELETE', `/v1/dashboard/budget-alerts/${ALERT_A}`)).statusCode).toBe(200)
      expect(actions().map((e) => [e.action, e.detail])).toEqual([
        ['alert.update', { threshold: 0.5 }],
        ['alert.delete', null],
      ])
    })
  })

  describe('governance', () => {
    it('records policy.set and mcp.approve, and nothing for a 404 unapprove', async () => {
      expect((await call('DELETE', '/v1/dashboard/governance/mcp-approvals?server=Neon')).statusCode).toBe(404)
      expect(actions()).toEqual([])
      await call('PUT', '/v1/dashboard/governance/agent-policy/claude', { rule: 'models', models: ['opus', 'opus'] })
      await call('PUT', '/v1/dashboard/governance/mcp-approvals', { server: 'Neon', note: 'ok' })
      expect(actions().map((e) => [e.action, e.detail])).toEqual([
        ['policy.set', { agent: 'claude', rule: 'models', models: ['opus'], note: null }],
        ['mcp.approve', { server: 'Neon', note: 'ok' }],
      ])
    })

    it('records policy.unset and mcp.unapprove', async () => {
      mongoState.docs.agentPolicies = [{ _id: 'x' }]
      mongoState.docs.mcpApprovals = [{ _id: 'y' }]
      await call('DELETE', '/v1/dashboard/governance/agent-policy/qwen')
      await call('DELETE', '/v1/dashboard/governance/mcp-approvals?server=Neon')
      expect(actions().map((e) => e.action)).toEqual(['policy.unset', 'mcp.unapprove'])
    })
  })

  describe('the write procedure', () => {
    it('answers normally and logs audit_write_failed with the event when the insert fails', async () => {
      mongoState.failOn = 'auditEvents.insertOne'
      const logged = vi.spyOn(app.log, 'error')
      const res = await call('POST', '/v1/dashboard/teams', { name: 'Platform' })
      expect(res.statusCode).toBe(201)
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          event: expect.objectContaining({ action: 'team.create', actorId: USER_A, orgId: ORG_A }),
        }),
        'audit_write_failed',
      )
    })

    it('has the audit row stored when the response arrives, so the write is awaited', async () => {
      const coll = getStore().auditEvents
      const original = coll.insertOne
      let landed = false
      // Slower than the handler's own work: an unawaited write would land after the response.
      coll.insertOne = async (doc) => {
        await new Promise((r) => setTimeout(r, 30))
        landed = true
        return original(doc)
      }
      try {
        const res = await call('POST', '/v1/dashboard/teams', { name: 'Platform' })
        expect(res.statusCode).toBe(201)
        expect(landed).toBe(true)
      } finally {
        coll.insertOne = original
      }
    })
  })

  describe('views', () => {
    it('records view.usage_distribution for an admin, scope org', async () => {
      mongoState.docs.users = [USER_A, USER_B, ...PEERS].map((_id) => ({ _id }))
      expect((await call('GET', `/v1/dashboard/usage-distribution?from=${DATE}&to=${DATE}`)).statusCode).toBe(200)
      expect(views()).toEqual([
        expect.objectContaining({
          _id: `view:${ORG_A}:${USER_A}:usage_distribution:all:${today()}`,
          action: 'view.usage_distribution',
          target: { type: 'scope', id: null, label: 'org' },
          detail: null,
        }),
      ])
    })

    it('records nothing for a person reading their own usage', async () => {
      expect((await call('GET', `/v1/dashboard/me/usage?from=${DATE}&to=${DATE}`, undefined, 'admin')).statusCode).toBe(200)
      expect(views()).toEqual([])
    })

    it('records the team for a manager reading with teamId', async () => {
      teamOf()
      const res = await call('GET', `/v1/dashboard/overview?from=${DATE}&to=${DATE}&teamId=${TEAM_A}`, undefined, 'manager')
      expect(res.statusCode).toBe(200)
      expect(views()).toEqual([
        expect.objectContaining({
          _id: `view:${ORG_A}:${USER_A}:overview:${TEAM_A}:${today()}`,
          action: 'view.overview',
          target: { type: 'team', id: TEAM_A, label: 'Platform' },
          detail: { people: 5 },
        }),
      ])
    })

    it('records nothing for overview without a team filter', async () => {
      await call('GET', `/v1/dashboard/overview?from=${DATE}&to=${DATE}`)
      expect(views()).toEqual([])
    })

    it('records nothing for a refused team read', async () => {
      mongoState.docs.teams = [{ _id: TEAM_A, orgId: ORG_A, name: 'Platform' }]
      const res = await call('GET', `/v1/dashboard/governance/free-tier?from=${DATE}&to=${DATE}&teamId=${TEAM_A}`, undefined, 'manager')
      expect(res.statusCode).toBe(403)
      expect(views()).toEqual([])
    })

    it('folds the three Governance reads into one _id', async () => {
      for (const path of ['free-tier', 'mcp', 'setup-checks']) {
        expect((await call('GET', `/v1/dashboard/governance/${path}?from=${DATE}&to=${DATE}`)).statusCode).toBe(200)
      }
      const ids = views().map((v) => v._id)
      expect(ids).toHaveLength(3)
      expect(new Set(ids)).toEqual(new Set([`view:${ORG_A}:${USER_A}:governance:all:${today()}`]))
    })

    // v2.1: who a view covered is kept on the row, so a later team change does not rewrite it.
    const covered = () =>
      mongoCalls('auditEvents', 'updateOne').map(
        ([, update]) => (update as { $addToSet?: { coveredUserIds: { $each: string[] } } }).$addToSet?.coveredUserIds.$each,
      )

    it('adds the org people at the time to a whole-org view', async () => {
      mongoState.docs.users = [USER_A, USER_B, ...PEERS].map((_id) => ({ _id }))
      expect((await call('GET', `/v1/dashboard/usage-distribution?from=${DATE}&to=${DATE}`)).statusCode).toBe(200)
      expect(covered()).toEqual([[USER_A, USER_B, ...PEERS]])
      // Unioned over the day: never in $setOnInsert, where it would conflict with $addToSet.
      expect(views()[0]).not.toHaveProperty('coveredUserIds')
    })

    it('adds the team members at the time to a team view', async () => {
      teamOf()
      await call('GET', `/v1/dashboard/overview?from=${DATE}&to=${DATE}&teamId=${TEAM_A}`, undefined, 'manager')
      expect(covered()).toEqual([[USER_A, USER_B, ...PEERS]])
    })

    it('records adoption, people and team comparison reads', async () => {
      await call('GET', '/v1/dashboard/adoption/unused-seats')
      await call('GET', '/v1/auth/admin/users')
      await call('GET', '/v1/auth/admin/devices')
      teamOf()
      await call('GET', `/v1/dashboard/teams/compare?from=${DATE}&to=${DATE}`)
      expect(views().map((v) => v.action)).toEqual(['view.adoption', 'view.people', 'view.people', 'view.team_compare'])
    })
  })

  describe('GET /v1/dashboard/audit', () => {
    it.each(['developer', 'manager'] as const)('answers 403 to a %s and reads nothing', async (role) => {
      const res = await call('GET', '/v1/dashboard/audit', undefined, role)
      expect(res.statusCode).toBe(403)
      expect(mongoState.calls.filter((c) => c.collection === 'auditEvents')).toEqual([])
    })

    it('builds the find from the filters, always on the caller org', async () => {
      const res = await call(
        'GET',
        `/v1/dashboard/audit?from=2026-11-01&to=2026-11-05&kind=action&actorId=${USER_B}&action=team.&targetId=${TEAM_A}&limit=50&offset=50`,
      )
      expect(res.statusCode).toBe(200)
      expect(mongoCalls('auditEvents', 'find')[0]).toEqual([
        {
          orgId: ORG_A,
          at: { $gte: new Date('2026-11-01T00:00:00.000Z'), $lt: new Date('2026-11-06T00:00:00.000Z') },
          kind: 'action',
          actorId: USER_B,
          action: { $regex: '^team\\.' },
          'target.id': TEAM_A,
        },
        { sort: { at: -1 }, skip: 50, limit: 50 },
      ])
    })

    it('defaults to the last 30 days, every kind, 100 rows', async () => {
      await call('GET', '/v1/dashboard/audit')
      const [filter, opts] = mongoCalls('auditEvents', 'find')[0] as [Record<string, unknown>, unknown]
      expect(filter).toEqual({
        orgId: ORG_A,
        at: { $gte: new Date(`${daysBefore(today(), 29)}T00:00:00.000Z`), $lt: expect.any(Date) },
      })
      expect(opts).toEqual({ sort: { at: -1 }, skip: 0, limit: 100 })
    })

    it('rejects an action prefix outside the closed list', async () => {
      expect((await call('GET', '/v1/dashboard/audit?action=%5E.*')).statusCode).toBe(400)
    })

    it('resolves actor names with one users.find in the caller org, and logs its own read', async () => {
      const at = new Date('2026-11-05T09:12:00.000Z')
      mongoState.docs.auditEvents = [
        { _id: 'e1', orgId: ORG_A, kind: 'action', action: 'team.create', actorId: USER_B, actorRole: 'admin', target: { type: 'team', id: TEAM_A, label: 'Platform' }, detail: { name: 'Platform' }, at, lastAt: null, count: 1, expiresAt: null },
        { _id: 'e2', orgId: ORG_A, kind: 'view', action: 'view.governance', actorId: USER_B, actorRole: 'admin', target: { type: 'scope', id: null, label: 'org' }, detail: null, at, lastAt: at, count: 4, expiresAt: at },
      ]
      mongoState.docs.users = [{ _id: USER_B, name: 'Priya' }]
      const res = await call('GET', '/v1/dashboard/audit')
      expect(res.statusCode).toBe(200)
      expect(mongoCalls('users', 'find')).toEqual([[{ _id: { $in: [USER_B] }, orgId: ORG_A }, { projection: { name: 1 } }]])
      expect(res.json()[1]).toEqual({
        id: 'e2',
        at: at.toISOString(),
        lastAt: at.toISOString(),
        count: 4,
        kind: 'view',
        action: 'view.governance',
        actor: { id: USER_B, name: 'Priya', role: 'admin' },
        target: { type: 'scope', id: null, label: 'org' },
        detail: null,
      })
      expect(views().map((v) => v.action)).toEqual(['view.audit'])
    })
  })

  describe('GET /v1/dashboard/audit/me', () => {
    const range = { $gte: expect.any(Date), $lt: expect.any(Date) }

    it.each(['developer', 'manager', 'admin'] as const)(
      'answers a %s with views that covered them, and writes no audit event',
      async (role) => {
        // The fake store ignores filters: this one row serves both teamMembers
        // reads, giving teamIds [TEAM_A] and managerIds [USER_B].
        mongoState.docs.teamMembers = [{ _id: `${TEAM_A}:${USER_B}`, teamId: TEAM_A, orgId: ORG_A, userId: USER_B, role: 'manager' }]
        const at = new Date('2026-11-05T09:12:00.000Z')
        mongoState.docs.auditEvents = [
          { _id: 'e1', orgId: ORG_A, kind: 'view', action: 'view.team', actorId: USER_B, actorRole: 'manager', target: { type: 'team', id: TEAM_A, label: 'Platform' }, detail: { people: 7 }, at, lastAt: at, count: 3, expiresAt: at },
          { _id: 'e2', orgId: ORG_A, kind: 'view', action: 'view.governance', actorId: 'gone', actorRole: 'admin', target: { type: 'scope', id: null, label: 'org' }, detail: null, at, lastAt: null, count: 1, expiresAt: at },
        ]
        mongoState.docs.users = [{ _id: USER_B, name: 'Priya' }]
        const res = await call('GET', '/v1/dashboard/audit/me', undefined, role)
        expect(res.statusCode).toBe(200)
        expect(mongoCalls('teamMembers', 'find').map(([f]) => f)).toEqual([
          { orgId: ORG_A, userId: USER_A },
          { orgId: ORG_A, teamId: { $in: [TEAM_A] }, role: 'manager' },
        ])
        expect(mongoCalls('auditEvents', 'find')).toEqual([
          [
            {
              orgId: ORG_A,
              kind: 'view',
              actorId: { $ne: USER_A },
              at: range,
              $or: [
                { coveredUserIds: USER_A },
                {
                  coveredUserIds: { $exists: false },
                  $or: [
                    { 'target.type': 'scope', 'target.label': 'org' },
                    { 'target.type': 'team', 'target.id': { $in: [TEAM_A] } },
                    { 'target.type': 'scope', 'target.label': 'managed teams', actorId: { $in: [USER_B] } },
                  ],
                },
              ],
            },
            { sort: { at: -1 }, limit: 1000 },
          ],
        ])
        expect(mongoCalls('users', 'find')).toEqual([[{ _id: { $in: [USER_B, 'gone'] }, orgId: ORG_A }, { projection: { name: 1 } }]])
        const body = res.json()
        expect(body.rows).toEqual([
          { at: at.toISOString(), lastAt: at.toISOString(), count: 3, surface: 'team', viewer: { name: 'Priya', role: 'manager' }, scope: 'Platform' },
          { at: at.toISOString(), lastAt: null, count: 1, surface: 'governance', viewer: { name: null, role: 'admin' }, scope: 'org' },
        ])
        const text = JSON.stringify(body)
        for (const leak of ['detail', 'people', TEAM_A, USER_B, 'actorId']) expect(text).not.toContain(leak)
        expect(views()).toEqual([])
        expect(actions()).toEqual([])
      },
    )

    /** The pre-v2.1 branch: rows with no coveredUserIds, matched by today's teams. */
    const legacyBranches = () =>
      (mongoCalls('auditEvents', 'find')[0][0] as { $or: [unknown, { $or: unknown }] }).$or[1].$or

    it('drops the team and manager branches when the caller is in no team', async () => {
      const res = await call('GET', '/v1/dashboard/audit/me', undefined, 'developer')
      expect(res.statusCode).toBe(200)
      expect(mongoCalls('teamMembers', 'find')).toHaveLength(1)
      expect(legacyBranches()).toEqual([
        { 'target.type': 'scope', 'target.label': 'org' },
      ])
      expect(mongoCalls('users', 'find')).toEqual([])
      expect(res.json().rows).toEqual([])
    })

    it('drops the manager branch when no team of the caller has a manager', async () => {
      const row = { _id: `${TEAM_A}:${USER_A}`, teamId: TEAM_A, orgId: ORG_A, userId: USER_A, role: 'member' }
      // The fake store ignores filters, so the manager read is emptied by hand.
      vi.spyOn(getStore().teamMembers, 'find').mockResolvedValueOnce([row] as never).mockResolvedValueOnce([])
      await call('GET', '/v1/dashboard/audit/me', undefined, 'developer')
      expect(legacyBranches()).toEqual([
        { 'target.type': 'scope', 'target.label': 'org' },
        { 'target.type': 'team', 'target.id': { $in: [TEAM_A] } },
      ])
    })

    it('uses the last 365 days by default and the given range otherwise', async () => {
      await call('GET', '/v1/dashboard/audit/me', undefined, 'developer')
      await call('GET', '/v1/dashboard/audit/me?from=2026-11-01&to=2026-11-05', undefined, 'developer')
      const [[a], [b]] = mongoCalls('auditEvents', 'find') as [[{ at: unknown }], [{ at: unknown }]]
      expect(a.at).toEqual({ $gte: new Date(`${daysBefore(today(), 364)}T00:00:00.000Z`), $lt: expect.any(Date) })
      expect(b.at).toEqual({ $gte: new Date('2026-11-01T00:00:00.000Z'), $lt: new Date('2026-11-06T00:00:00.000Z') })
    })

    it('answers 400 when from is after to, and reads nothing', async () => {
      const res = await call('GET', '/v1/dashboard/audit/me?from=2026-11-05&to=2026-11-01', undefined, 'developer')
      expect(res.statusCode).toBe(400)
      expect(mongoState.calls).toEqual([])
    })
  })
})

describe('GET /v1/prices', () => {
  it('serves the embedded table without a token, keyed by its version', async () => {
    const { PRICE_TABLE } = await import('@burn-watch/shared/prices')
    const res = await app.inject({ method: 'GET', url: '/v1/prices' })
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBe(`"${PRICE_TABLE.version}"`)
    expect(res.headers['cache-control']).toBe('public, max-age=86400')
    expect(res.json()).toEqual(PRICE_TABLE)
  })

  it('answers 304 with no body when the caller already has this version', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/prices' })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/prices',
      headers: { 'if-none-match': String(first.headers.etag) },
    })
    expect(res.statusCode).toBe(304)
    expect(res.body).toBe('')
  })

  it('sends the full table for a stale version', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/prices', headers: { 'if-none-match': '"old"' } })
    expect(res.statusCode).toBe(200)
  })
})
