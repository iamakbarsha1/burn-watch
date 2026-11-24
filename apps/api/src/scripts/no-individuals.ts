/**
 * v2 rule check: no dashboard response names another person, unless the route
 * is an admin operation on the allowlist below. Also checks the minimum group
 * size: a scoped read over fewer than MIN_GROUP_SIZE people is refused.
 *
 * Runs against a real MongoDB, like dashboard-pipelines. The route tests' fake
 * store ignores filters and returns one canned aggregate per collection, so a
 * leak check on it would pass or fail for reasons unrelated to the routes.
 * Here the data goes in through POST /v1/usage, the same path the agent uses,
 * and every dashboard GET is called as admin, manager and developer.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27117/burnwatch_dash?replicaSet=rs0 \
 *     BW_DASHBOARD_ALLOW_WRITES=1 npx tsx src/scripts/no-individuals.ts
 *
 * The ingest route runs a transaction, so the server must be a replica set:
 * `packages/db/scripts/local-replset.sh up` prints a URI for one.
 *
 * KNOWN_LEAKS is a ratchet. It lists the routes that still name people today
 * and the v2 phase that removes them. A route that leaks and is not listed
 * fails the run, and so does a listed route that no longer leaks, so the list
 * can only shrink and has to be edited when a phase lands.
 */
import {
  COLLECTIONS,
  getClient,
  getDb,
  newId,
  seatKey,
  syncSchema,
  teamMemberKey,
  agentPolicyKey,
  microsFromUsd,
  type DeviceId,
  type IsoDate,
  type OrgId,
  type TeamId,
  type UserId,
} from '@burn-watch/db'
import type { FastifyInstance } from 'fastify'
import type { JwtPayload } from '../plugins/jwt.js'

process.env.JWT_SECRET ??= 'no-individuals-access-secret'
process.env.JWT_REFRESH_SECRET ??= 'no-individuals-refresh-secret'
// Request logs would bury the report.
process.env.NODE_ENV = 'test'

type Role = 'admin' | 'manager' | 'developer'

/** Named per-person data that an admin needs to act on one person. Admin only. */
const ALLOWED: Record<string, { roles: Role[]; why: string }> = {
  '/v1/auth/admin/users': { roles: ['admin'], why: 'user admin: invite, role, deactivate' },
  '/v1/auth/admin/devices': { roles: ['admin'], why: 'device admin: revoke a laptop' },
  '/v1/dashboard/seats': { roles: ['admin'], why: 'seat admin: who holds a paid seat' },
  '/v1/dashboard/teams': { roles: ['admin', 'manager'], why: 'team roster for the filter: names only, no usage' },
  '/v1/dashboard/adoption/idle-seats': { roles: ['admin'], why: 'unused seats: reclaim a licence' },
  '/v1/dashboard/governance/violations': { roles: ['admin'], why: 'setup checks: fix a security setting' },
}

/**
 * Routes that name people today, with the phase that fixes them. Keys are
 * `route role`. Emptied by Phases 1 to 3.
 */
const KNOWN_LEAKS: Record<string, string> = {
  // Phase 2: adoption without names.
  '/v1/dashboard/adoption/funnel admin': 'P2',
  '/v1/dashboard/adoption/funnel manager of 6': 'P2',
  '/v1/dashboard/adoption/features admin': 'P2',
  '/v1/dashboard/adoption/features manager of 6': 'P2',
  '/v1/dashboard/adoption/onboarding admin': 'P2',
  '/v1/dashboard/adoption/onboarding manager of 6': 'P2',
  '/v1/dashboard/adoption/practices admin': 'P2',
  '/v1/dashboard/adoption/practices manager of 6': 'P2',
  // Phase 3: governance and alerts.
  '/v1/dashboard/adoption/idle-seats manager of 6': 'P3',
  '/v1/dashboard/budget-alerts admin': 'P3',
  '/v1/dashboard/budget-alerts manager of 6': 'P3',
  '/v1/dashboard/governance/accounts admin': 'P3',
  '/v1/dashboard/governance/free-tier admin': 'P3',
  '/v1/dashboard/governance/free-tier manager of 6': 'P3',
  '/v1/dashboard/governance/mcp admin': 'P3',
  '/v1/dashboard/governance/mcp manager of 6': 'P3',
  '/v1/dashboard/governance/violations manager of 6': 'P3',
}

/** Routes that take `teamId` and report numbers over the scope. */
const TEAM_FILTERED = [
  '/v1/dashboard/overview',
  '/v1/dashboard/trends',
  '/v1/dashboard/usage-distribution',
  '/v1/dashboard/adoption/funnel',
  '/v1/dashboard/adoption/features',
  '/v1/dashboard/adoption/onboarding',
  '/v1/dashboard/adoption/practices',
  '/v1/dashboard/adoption/idle-seats',
  '/v1/dashboard/governance/free-tier',
  '/v1/dashboard/governance/mcp',
  '/v1/dashboard/governance/violations',
  '/v1/dashboard/governance/accounts',
]
/** Routes with no team filter that report numbers over the viewer's scope. */
const VIEWER_SCOPED = ['/v1/dashboard/activity', '/v1/dashboard/projects', '/v1/dashboard/tickets']
/** Admin-only among the above: a manager's 403 there is the role check, not k. */
const ADMIN_ONLY = new Set(['/v1/dashboard/governance/accounts'])

const today = new Date().toISOString().slice(0, 10) as IsoDate
const dayOffset = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10) as IsoDate
const FROM = dayOffset(-14)
const TO = dayOffset(-1)

const ORG = newId<OrgId>()
const BIG = newId<TeamId>()
const SMALL = newId<TeamId>()
const ORG_HASH = 'a'.repeat(64)
const PERSONAL_HASH = 'b'.repeat(64)

interface Person {
  id: UserId
  device: DeviceId
  name: string
  email: string
  role: Role
  /** Active days out of the last 14, most recent first. 0 = never used it. */
  days: number
  newHire?: boolean
  personalAccount?: boolean
  freeTier?: boolean
  limitHits?: number
}

// Names that cannot appear in a response by accident.
const person = (key: string, name: string, role: Role, days: number, extra: Partial<Person> = {}): Person => ({
  id: newId<UserId>(),
  device: newId<DeviceId>(),
  name,
  email: `${key}.${ORG.slice(0, 8)}@noindiv.test`,
  role,
  days,
  ...extra,
})

const ADMIN = person('admin', 'Quorra Admintest', 'admin', 3)
const BIG_MGR = person('bigmgr', 'Wendell Bigmanager', 'manager', 10)
const SMALL_MGR = person('smallmgr', 'Thaddea Smallmanager', 'manager', 4)
const BIG_DEVS = [
  person('b1', 'Ysolde Heavyuser', 'developer', 14, { limitHits: 3 }),
  person('b2', 'Corvin Personalacct', 'developer', 9, { personalAccount: true }),
  person('b3', 'Elspeth Freetier', 'developer', 6, { freeTier: true }),
  person('b4', 'Bramwell Newhire', 'developer', 2, { newHire: true }),
  person('b5', 'Odalys Neverused', 'developer', 0),
]
const SMALL_DEV = person('s1', 'Fenwick Smallteam', 'developer', 5, { newHire: true })
const PEOPLE = [ADMIN, BIG_MGR, SMALL_MGR, ...BIG_DEVS, SMALL_DEV]

async function clean() {
  const ids = PEOPLE.map((p) => p.id)
  const devices = PEOPLE.map((p) => p.device)
  const db = getDb()
  for (const name of Object.keys(COLLECTIONS)) {
    await db.collection(name).deleteMany({
      $or: [{ orgId: ORG }, { userId: { $in: ids } }, { deviceId: { $in: devices } }, { _id: { $in: [...ids, ...devices] } }],
    } as never)
  }
}

async function seedDocs() {
  const db = getDb()
  const old = new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 86_400_000)
  const recent = new Date(Date.parse(`${today}T00:00:00Z`) - 10 * 86_400_000)
  await db.collection('organizations').insertOne({
    _id: ORG,
    name: 'No Individuals Org',
    slug: `noindiv-${ORG.slice(0, 8)}`,
    githubOrg: null,
    createdAt: old,
    ownClaudeOrgHashes: [ORG_HASH],
    ticketPrefixes: ['BW'],
    minClaudeVersion: '2.0.0',
  } as never)
  await db.collection('users').insertMany(
    PEOPLE.map((p) => ({
      _id: p.id,
      orgId: ORG,
      email: p.email,
      name: p.name,
      githubUsername: null,
      role: p.role,
      isActive: true,
      createdAt: p.newHire ? recent : old,
    })) as never,
  )
  await db.collection('teams').insertMany([
    { _id: BIG, orgId: ORG, name: 'Big team', createdAt: old },
    { _id: SMALL, orgId: ORG, name: 'Small team', createdAt: old },
  ] as never)
  const member = (teamId: TeamId, p: Person, role: 'manager' | 'member') => ({
    _id: teamMemberKey(teamId, p.id),
    teamId,
    orgId: ORG,
    userId: p.id,
    role,
    createdAt: old,
  })
  await db.collection('teamMembers').insertMany([
    member(BIG, BIG_MGR, 'manager'),
    ...BIG_DEVS.map((p) => member(BIG, p, 'member')),
    member(SMALL, SMALL_MGR, 'manager'),
    member(SMALL, SMALL_DEV, 'member'),
  ] as never)
  await db.collection('devices').insertMany(
    PEOPLE.map((p) => ({
      _id: p.device,
      userId: p.id,
      hostname: `host-${p.email.split('@')[0]}`,
      platform: 'darwin',
      agentVersion: '0.6.0',
      claudeVersion: '2.1.0',
      lastSeenAt: recent,
      createdAt: old,
    })) as never,
  )
  await db.collection('deviceTokens').insertMany(
    PEOPLE.map((p) => ({
      _id: `tok-${p.device}`,
      deviceId: p.device,
      tokenHash: 'x',
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      createdAt: old,
    })) as never,
  )
  await db.collection('seats').insertMany(
    PEOPLE.map((p) => ({
      _id: seatKey(p.id, 'claude'),
      orgId: ORG,
      userId: p.id,
      agent: 'claude',
      monthlyPriceMicros: microsFromUsd(100),
      startDate: dayOffset(-60),
      createdAt: old,
    })) as never,
  )
  await db.collection('agentPolicies').insertOne({
    _id: agentPolicyKey(ORG, 'qwen'),
    orgId: ORG,
    agent: 'qwen',
    rule: 'blocked',
    models: [],
    note: null,
    updatedBy: ADMIN.id,
    updatedAt: old,
  } as never)
  await db.collection('budgetAlerts').insertMany([
    {
      _id: newId(),
      orgId: ORG,
      type: 'limit-hit',
      userId: null,
      agent: null,
      monthlyLimitMicros: 0,
      threshold: 0.8,
      idleDays: null,
      limitHits: 1,
      trippedAt: null,
      createdAt: old,
    },
    {
      _id: newId(),
      orgId: ORG,
      type: 'api-spend',
      userId: BIG_DEVS[0].id,
      agent: null,
      monthlyLimitMicros: microsFromUsd(1),
      threshold: 0.8,
      idleDays: null,
      limitHits: null,
      trippedAt: null,
      createdAt: old,
    },
  ] as never)
}

function payload(p: Person, date: IsoDate) {
  const event = (agent: string, modelName: string, tokens: number, costUsd: number, isFreeTier: boolean) => ({
    agent,
    date,
    modelName,
    inputTokens: tokens,
    outputTokens: tokens,
    cacheCreateTokens: 0,
    cacheReadTokens: tokens,
    totalTokens: tokens * 3,
    costUsd,
    isFreeTier,
  })
  const events = [event('claude', 'claude-sonnet-4', 40_000, 2.5, false)]
  if (p.freeTier) events.push(event('qwen', 'qwen3-coder', 10_000, 0, true))
  return {
    deviceId: p.device,
    date,
    agentVersion: '0.6.0',
    events,
    enrichment: {
      date,
      sessionCount: 3,
      callCount: 40,
      cacheHitRate: 60,
      writtenTokens: 40_000,
      activityBreakdown: [],
      projectBreakdown: [
        {
          path: 'burn-watch',
          remote: 'github.com/example/burn-watch',
          branches: [
            { name: 'feat/BW-12-thing', cost: 1.5, sessions: 2 },
            { name: 'scratch', cost: 1, sessions: 1 },
          ],
          cost: 2.5,
          avgPerSession: 0.83,
          sessions: 3,
          overheadK: 10,
        },
      ],
      topSessions: [],
      toolUsage: { Read: 20, Edit: 10, Task: 2, TodoWrite: 1 },
      shellUsage: { git: 4, npm: 2 },
      mcpUsage: { github: 3 },
      limitHitCount: p.limitHits ?? 0,
      claudeVersions: { '1.9.0': 40 },
      entrypointCounts: { cli: 40 },
      skillCounts: { review: 2 },
      sidechainMessages: 4,
      permissionModeCounts: { plan: 1, default: 5 },
      accountHashes: [p.personalAccount ? PERSONAL_HASH : ORG_HASH],
      claudeOrgHashes: [p.personalAccount ? PERSONAL_HASH : ORG_HASH],
    },
  }
}

async function ingest(app: FastifyInstance) {
  for (const p of PEOPLE) {
    const token = app.jwt.access.sign({ userId: p.id, orgId: ORG, role: 'device', deviceId: p.device } as JwtPayload)
    for (let i = 1; i <= p.days; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/usage',
        headers: { authorization: `Bearer ${token}` },
        payload: payload(p, dayOffset(-i)),
      })
      if (res.statusCode >= 300) throw new Error(`ingest ${p.name} ${dayOffset(-i)}: ${res.statusCode} ${res.body}`)
    }
  }
}

/** Every identity string a response could carry for someone other than the caller. */
function leaksIn(body: string, caller: Person): Person[] {
  return PEOPLE.filter((p) => p !== caller && [p.id, p.email, p.name].some((s) => body.includes(s)))
}

interface Result {
  route: string
  caller: string
  role: Role
  variant: string
  status: number
  error?: string
  leaked: Person[]
  body: string
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set')
  if (process.env.BW_DASHBOARD_ALLOW_WRITES !== '1') {
    throw new Error('refusing to write: set BW_DASHBOARD_ALLOW_WRITES=1, and point at a throwaway database')
  }

  const { buildServer } = await import('../build-server.js')
  const app = buildServer()
  const routes: string[] = []
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method]
    if (!methods.includes('GET') || r.url.includes(':')) return
    if (r.url.startsWith('/v1/dashboard') || r.url.startsWith('/v1/auth')) routes.push(r.url)
  })
  await app.ready()

  const failures: string[] = []
  const results: Result[] = []
  try {
    await syncSchema(getDb())
    await clean()
    await seedDocs()
    await ingest(app)

    const callers: [Person, string][] = [
      [ADMIN, 'admin'],
      [BIG_MGR, 'manager of 6'],
      [SMALL_MGR, 'manager of 2'],
      [BIG_DEVS[0], 'developer'],
    ]
    const variants: [string, string][] = [
      ['org', ''],
      ['team 6', `&teamId=${BIG}`],
      ['team 2', `&teamId=${SMALL}`],
    ]
    for (const route of [...new Set(routes)].sort()) {
      for (const [caller, label] of callers) {
        const token = app.jwt.access.sign({ userId: caller.id, orgId: ORG, role: caller.role } as JwtPayload)
        for (const [variant, extra] of variants) {
          const res = await app.inject({
            method: 'GET',
            url: `${route}?from=${FROM}&to=${TO}${extra}`,
            headers: { authorization: `Bearer ${token}` },
          })
          let error: string | undefined
          try {
            error = (JSON.parse(res.body) as { error?: string }).error
          } catch {
            error = undefined
          }
          results.push({ route, caller: label, role: caller.role, variant, status: res.statusCode, error, leaked: leaksIn(res.body, caller), body: res.body })
        }
      }
    }
  } finally {
    await clean()
    await app.close()
    await getClient().close()
  }

  // Rule: no other person's identity outside the allowlist.
  const leakKeys = new Set<string>()
  for (const r of results) {
    if (r.leaked.length === 0) continue
    if (ALLOWED[r.route]?.roles.includes(r.role)) continue
    const key = `${r.route} ${r.caller}`
    leakKeys.add(key)
    if (!(key in KNOWN_LEAKS)) {
      failures.push(`LEAK ${key} [${r.variant}] names: ${r.leaked.map((p) => p.name).join(', ')}`)
    }
  }
  for (const key of Object.keys(KNOWN_LEAKS)) {
    if (!leakKeys.has(key)) failures.push(`STALE known leak, remove it from KNOWN_LEAKS: ${key}`)
  }

  // Rule: a read over fewer than MIN_GROUP_SIZE people is refused, and only
  // that: the same routes still answer for a group of 6 and for a person's own data.
  const at = (route: string, caller: string, variant: string) =>
    results.find((r) => r.route === route && r.caller === caller && r.variant === variant)
  const expect = (route: string, caller: string, variant: string, want: 'k' | 200) => {
    const r = at(route, caller, variant)
    if (!r) return failures.push(`MISSING ${route} ${caller} [${variant}]: route not registered`)
    const got = r.status === 403 && r.error === 'group_too_small' ? 'k' : r.status
    if (got !== want) failures.push(`SMALL GROUP ${route} ${caller} [${variant}] answered ${r.status} ${r.error ?? ''}, expected ${want === 'k' ? '403 group_too_small' : 200}`)
  }
  for (const route of TEAM_FILTERED) {
    expect(route, 'admin', 'team 2', 'k')
    expect(route, 'admin', 'team 6', 200)
    if (ADMIN_ONLY.has(route)) continue
    expect(route, 'manager of 2', 'org', 'k')
    expect(route, 'manager of 2', 'team 2', 'k')
    expect(route, 'manager of 6', 'org', 200)
    expect(route, 'manager of 6', 'team 6', 200)
  }
  for (const route of VIEWER_SCOPED) {
    expect(route, 'manager of 2', 'org', 'k')
    expect(route, 'manager of 6', 'org', 200)
    expect(route, 'developer', 'org', 200)
  }
  for (const route of ['/v1/dashboard/overview', '/v1/dashboard/trends']) expect(route, 'developer', 'org', 200)
  // Your own usage is never refused, whatever your role or team size.
  for (const caller of ['admin', 'manager of 6', 'manager of 2', 'developer']) expect('/v1/dashboard/me/usage', caller, 'org', 200)
  for (const caller of ['admin', 'manager of 2']) {
    const r = at('/v1/dashboard/teams/compare', caller, 'org')
    if (r?.status === 200 && r.body.includes(SMALL)) failures.push(`SMALL GROUP /v1/dashboard/teams/compare ${caller} shows the 2-person team`)
  }
  const big = at('/v1/dashboard/teams/compare', 'admin', 'org')
  if (!big?.body.includes(BIG)) failures.push('teams/compare admin no longer shows the 6-person team')

  const statuses = new Map<string, string[]>()
  for (const r of results) {
    const k = r.route
    statuses.set(k, [...(statuses.get(k) ?? []), `${r.caller}/${r.variant}=${r.status}${r.error === 'group_too_small' ? '(k)' : ''}`])
  }
  for (const [route, s] of statuses) console.log(`${route}\n    ${s.join('  ')}`)
  console.log('')

  if (failures.length > 0) {
    for (const f of [...new Set(failures)]) console.log(`FAIL ${f}`)
    console.log(`\n${new Set(failures).size} failures across ${statuses.size} routes`)
    process.exit(1)
  }
  console.log(`PASS: ${statuses.size} routes, ${results.length} calls, no one named outside the allowlist`)
  console.log(`  ${Object.keys(KNOWN_LEAKS).length} known leaks left for Phases 1 to 3`)
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exit(1)
})
