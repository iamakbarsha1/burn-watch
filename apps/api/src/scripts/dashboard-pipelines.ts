/**
 * The five dashboard aggregations, plus the admin roster, admin devices and
 * rate-limit pipelines, run against a real MongoDB, checked against
 * figures worked out by hand.
 *
 * Deliberately not part of `npm test`. The route tests seed the fake store with
 * the rows an aggregate answered and never look at the pipeline, which is a
 * deliberate bargain — a fake that honoured filters would be a second,
 * unverified MongoDB, and the one stage it got subtly wrong is the one nothing
 * would catch. `*-query.test.ts` read the stages as data, which catches a
 * missing `$match` and cannot catch a `$group` that sums the wrong field.
 *
 * This is where that gap closes. Three classes of fault live only here:
 *
 *   - arithmetic: whether `$group` sums what the page prints;
 *   - grain: whether `$addToSet` plus `$size` counts people where counting
 *     documents would count user-days;
 *   - scoping: whether the `$match` keeps another org out. Two orgs are seeded
 *     for every case, because a suite that seeds one org passes whether the
 *     filter is there or not. That blindness appeared four times in one diff.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27117/burnwatch_dash?replicaSet=rs0 \
 *     BW_DASHBOARD_ALLOW_WRITES=1 npx tsx src/scripts/dashboard-pipelines.ts
 *
 * `packages/db/scripts/local-replset.sh up` prints a URI for a disposable set,
 * and an Atlas URI works as well — these are plain reads and need no replica
 * set of their own. It writes its own organizations, users, snapshots and
 * enrichment under two generated org ids and deletes them on the way out, so it
 * never reads or writes a document another process made. It does leave schema
 * behind: `syncSchema` ensures every collection and index in the registry.
 * Point it at a throwaway database.
 */
import { strict as assert } from 'node:assert'
import { MongoClient } from 'mongodb'
import type { AdminDeviceRow, AdminUserRow, ProjectEntry } from '@burn-watch/shared'
import {
  dayKey,
  idleSeats,
  limitHitsThisMonth,
  microsFromUsd,
  monthToDateSpend,
  newId,
  seatKey,
  seatLastUsed,
  seatedKeys,
  storeFor,
  syncSchema,
  type ClaudeEnrichmentDoc,
  type DailySnapshotDoc,
  type DeviceDoc,
  type DeviceId,
  type DeviceTokenDoc,
  type IsoDate,
  type OrgId,
  type SeatDoc,
  type Store,
  type UserId,
} from '@burn-watch/db'
import { toolUsageTotals } from '../routes/dashboard/activity.js'
import { leaderboardPipeline } from '../routes/dashboard/leaderboard.js'
import { dayBefore } from '../routes/dashboard/dates.js'
import { overviewPipeline } from '../routes/dashboard/overview.js'
import { projectTotals } from '../routes/dashboard/projects.js'
import { trendsPipeline } from '../routes/dashboard/trends.js'
import { adminDevicesPipeline, adminUsersPipeline } from '../routes/auth/device.js'
import { funnelUsersPipeline } from '../routes/dashboard/adoption.js'
import { hitPipeline } from '../plugins/rate-limit-store.js'

const D1 = '2026-06-01' as IsoDate
const D2 = '2026-06-02' as IsoDate
const D3 = '2026-06-03' as IsoDate

const MINE = newId<OrgId>()
const THEIRS = newId<OrgId>()
const ADA = newId<UserId>()
const BO = newId<UserId>()
const CY = newId<UserId>()
const DI = newId<UserId>()
const ZED = newId<UserId>()

type AgentSlice = DailySnapshotDoc['byAgent']

function snapshot(
  userId: UserId,
  orgId: OrgId,
  date: IsoDate,
  byAgent: AgentSlice,
  sessionCount: number,
): DailySnapshotDoc {
  let totalTokens = 0
  let totalCostMicros = 0
  for (const slice of Object.values(byAgent)) {
    totalTokens += slice.tokens
    totalCostMicros += slice.costMicros
  }
  return {
    _id: dayKey(userId, date),
    userId,
    orgId,
    date,
    byAgent,
    totalTokens,
    totalCostMicros: totalCostMicros as DailySnapshotDoc['totalCostMicros'],
    callCount: 0,
    sessionCount,
    cacheHitRate: null,
    modelsUsed: [],
    updatedAt: new Date(),
  }
}

const slice = (tokens: number, usd: number) => ({ tokens, costMicros: microsFromUsd(usd) })

const project = (path: string, cost: number, sessions: number, remote?: string): ProjectEntry => ({
  path,
  ...(remote ? { remote } : {}),
  cost,
  sessions,
  avgPerSession: sessions > 0 ? cost / sessions : 0,
  overheadK: 0,
})

function enrichment(
  userId: UserId,
  orgId: OrgId,
  date: IsoDate,
  blobs: Partial<
    Pick<
      ClaudeEnrichmentDoc,
      'toolUsage' | 'shellUsage' | 'mcpUsage' | 'projectBreakdown' | 'limitHitCount' | 'claudeVersions'
    >
  >,
): ClaudeEnrichmentDoc {
  return {
    _id: dayKey(userId, date),
    userId,
    orgId,
    date,
    writtenTokens: 0,
    activityBreakdown: null,
    topSessions: null,
    toolUsage: null,
    shellUsage: null,
    mcpUsage: null,
    projectBreakdown: null,
    limitHitCount: null,
    claudeVersions: null,
    entrypointCounts: null,
    skillCounts: null,
    sidechainMessages: null,
    permissionModeCounts: null,
    accountHashes: null,
    claudeOrgHashes: null,
    submittedAt: new Date(),
    ...blobs,
  }
}

/**
 * Both orgs look the same shape. THEIRS is loud on every field the assertions
 * read, so a dropped `$match` shows up as a wrong number rather than as a row
 * count that happens to stay the same.
 */
const SNAPSHOTS: DailySnapshotDoc[] = [
  // ADA works two days, which is the case that separates people from user-days.
  snapshot(ADA, MINE, D1, { claude: slice(1_000, 3) }, 2),
  snapshot(ADA, MINE, D2, { claude: slice(2_000, 5), copilot: slice(500, 1) }, 3),
  snapshot(BO, MINE, D2, { qwen: slice(7_000, 0) }, 4),
  // Inserted third and outspends everyone in range, so a pipeline that pages
  // before it sorts returns a different person than one that sorts first.
  // With insertion order and spend order agreeing, that mutation survives.
  snapshot(DI, MINE, D2, { gemini: slice(4_000, 40) }, 6),
  // Outside every range under test.
  snapshot(CY, MINE, D3, { codex: slice(300, 11) }, 1),
  snapshot(ZED, THEIRS, D1, { claude: slice(999_999, 777) }, 99),
  snapshot(ZED, THEIRS, D2, { claude: slice(999_999, 777) }, 99),
]

const ENRICHMENT: ClaudeEnrichmentDoc[] = [
  enrichment(ADA, MINE, D1, {
    limitHitCount: 2,
    toolUsage: { bash: 5, edit: 2 },
    shellUsage: { git: 1 },
    projectBreakdown: [project('acme/widgets', 4, 2)],
  }),
  enrichment(ADA, MINE, D2, {
    // `git` appears as a tool here and as a shell above: two different counts
    // that a group key missing the category would silently add together.
    toolUsage: { bash: 3, git: 2 },
    shellUsage: { git: 4 },
    mcpUsage: { neon: 6 },
    projectBreakdown: [project('acme/widgets', 6, 3), project('acme/gadgets', 1, 1)],
  }),
  // Every blob null but one: the case `$ifNull` exists for.
  enrichment(BO, MINE, D2, {
    limitHitCount: 1,
    mcpUsage: { neon: 1 },
    projectBreakdown: [project('acme/widgets', 2, 1)],
  }),
  // Empty rather than null, and in range: `{}` and `[]` are the cases the
  // deleted node-merge tests covered and no fixture reached afterwards.
  enrichment(DI, MINE, D2, { toolUsage: {}, shellUsage: {}, projectBreakdown: [] }),
  enrichment(CY, MINE, D3, { toolUsage: { bash: 999 } }),
  // 0.4 agents: two `api` repos with one name and two remotes must stay two
  // rows. The version map has dotted keys, which Mongo stores as field names.
  enrichment(CY, MINE, D1, {
    projectBreakdown: [project('api', 3, 1, 'github.com/one/api'), project('api', 2, 1, 'github.com/two/api')],
    claudeVersions: { '2.1.330': 3, '2.1.99': 1 },
  }),
  enrichment(ZED, THEIRS, D1, {
    limitHitCount: 50,
    toolUsage: { bash: 1_000 },
    projectBreakdown: [project('acme/widgets', 500, 50)],
  }),
]

const user = (_id: UserId, orgId: OrgId, name: string) => ({
  _id,
  orgId,
  email: `${name.toLowerCase()}@example.invalid`,
  name,
  githubUsername: null,
  role: 'developer' as const,
  isActive: true,
  createdAt: new Date(),
})

const USERS = [
  user(ADA, MINE, 'Ada'),
  user(BO, MINE, 'Bo'),
  user(CY, MINE, 'Cy'),
  user(DI, MINE, 'Di'),
  user(ZED, THEIRS, 'Zed'),
]

const ALPHA = newId<DeviceId>()
const ZETA = newId<DeviceId>()
const DI_BOX = newId<DeviceId>()
const ZED_BOX = newId<DeviceId>()

const device = (_id: DeviceId, userId: UserId, hostname: string, lastSeenAt: string): DeviceDoc => ({
  _id,
  userId,
  hostname,
  platform: 'darwin',
  agentVersion: '0.1.0',
  claudeVersion: null,
  lastSeenAt: new Date(lastSeenAt),
  createdAt: new Date(),
})

// ADA owns two devices, inserted out of name order, so the hostname sort and
// the per-user max both have something to do. BO owns none.
const DEVICES = [
  device(ZETA, ADA, 'zeta', '2026-06-02T10:00:00.789Z'),
  device(ALPHA, ADA, 'alpha', '2026-06-01T08:00:00.000Z'),
  device(DI_BOX, DI, 'di-box', '2026-06-03T00:00:00.000Z'),
  device(ZED_BOX, ZED, 'zed-box', '2026-06-09T00:00:00.000Z'),
]

const token = (deviceId: DeviceId, revokedAt: Date | null): DeviceTokenDoc => ({
  _id: newId(),
  deviceId,
  tokenHash: 'x'.repeat(64),
  expiresAt: new Date('2026-01-01'),
  revokedAt,
  createdAt: new Date(),
})

// ALPHA holds one live and one revoked token: live wins. ZETA holds only a
// revoked one, DI_BOX none at all. ZED_BOX is live in the other org.
const TOKENS = [
  token(ALPHA, new Date()),
  token(ALPHA, null),
  token(ZETA, new Date()),
  token(ZED_BOX, null),
]

const seat = (userId: UserId, orgId: OrgId, agent: SeatDoc['agent'], startDate: string): SeatDoc => ({
  _id: seatKey(userId, agent),
  orgId,
  userId,
  agent,
  monthlyPriceMicros: microsFromUsd(30),
  startDate: startDate as IsoDate,
  createdAt: new Date(),
})

const SEATS = [
  seat(ADA, MINE, 'claude', '2026-05-01'), // used on D2
  seat(BO, MINE, 'qwen', '2026-05-01'), // tokens on D2 at $0: used, not idle
  seat(CY, MINE, 'claude', '2026-05-01'), // CY only ran codex: idle
  seat(DI, MINE, 'gemini', D3), // younger than the window: ignored
  seat(ZED, THEIRS, 'claude', '2026-05-01'), // another org, idle, must not show
]

const RATE_KEY = `dashboard-pipelines-${MINE}`

async function seed(store: Store) {
  await store.organizations.insertOne({
    _id: MINE,
    name: 'Mine',
    slug: `mine-${MINE}`,
    githubOrg: null,
    createdAt: new Date(),
  })
  await store.organizations.insertOne({
    _id: THEIRS,
    name: 'Theirs',
    slug: `theirs-${THEIRS}`,
    githubOrg: null,
    createdAt: new Date(),
  })
  for (const u of USERS) await store.users.insertOne(u)
  for (const s of SNAPSHOTS) await store.dailySnapshots.insertOne(s)
  for (const e of ENRICHMENT) await store.claudeEnrichment.insertOne(e)
  for (const d of DEVICES) await store.devices.insertOne(d)
  for (const t of TOKENS) await store.deviceTokens.insertOne(t)
  for (const s of SEATS) await store.seats.insertOne(s)
}

async function clean(store: Store) {
  const orgs = { orgId: { $in: [MINE, THEIRS] } }
  await store.dailySnapshots.deleteMany(orgs)
  await store.claudeEnrichment.deleteMany(orgs)
  await store.seats.deleteMany(orgs)
  await store.deviceTokens.deleteMany({ deviceId: { $in: DEVICES.map((d) => d._id) } })
  await store.devices.deleteMany({ userId: { $in: USERS.map((u) => u._id) } })
  await store.rateLimits.deleteMany({ _id: RATE_KEY })
  await store.users.deleteMany(orgs)
  await store.organizations.deleteMany({ _id: { $in: [MINE, THEIRS] } })
}

const checks: string[] = []
function check(what: string, fn: () => void) {
  fn()
  checks.push(what)
}

async function overview(store: Store) {
  const [facet] = await store.dailySnapshots.aggregate(
    overviewPipeline(MINE, D1, D2, dayBefore(D1)),
  )
  const totals = facet.totals[0]
  const byAgent = new Map(
    (facet.byAgent as { _id: string; tokens: number; costMicros: number }[]).map((r) => [r._id, r]),
  )

  check('overview sums only the caller org', () => {
    assert.equal(
      totals.costMicros,
      microsFromUsd(49),
      'ADA 3 + 5 + 1, BO 0, DI 40, and nothing of THEIRS',
    )
    assert.equal(totals.tokens, 14_500)
  })

  check('overview counts people, not user-days or days', () => {
    // Three people over two dates, and ADA holds two of the four snapshots.
    // Counting documents answers 4 and counting dates answers 2, so neither
    // mistake can pass as the right number here — which is the only thing that
    // makes this assertion mean what its name says.
    assert.equal(totals.activeUsers, 3)
  })

  check('overview splits by agent without naming one', () => {
    assert.deepEqual(byAgent.get('claude'), {
      _id: 'claude',
      tokens: 3_000,
      costMicros: microsFromUsd(8),
    })
    assert.deepEqual(byAgent.get('copilot'), {
      _id: 'copilot',
      tokens: 500,
      costMicros: microsFromUsd(1),
    })
    // A free tier still reports its tokens.
    assert.deepEqual(byAgent.get('qwen'), { _id: 'qwen', tokens: 7_000, costMicros: 0 })
    assert.deepEqual(byAgent.get('gemini'), {
      _id: 'gemini',
      tokens: 4_000,
      costMicros: microsFromUsd(40),
    })
    assert.equal(byAgent.has('codex'), false, 'CY worked on D3, outside the range')
  })

  check('overview splits value per (user, agent), so seated pairs can be told from API spend', () => {
    const pairs = (facet.pairs as { _id: { userId: string; agent: string }; costMicros: number }[])
      .map((p) => `${p._id.userId === ADA ? 'ADA' : p._id.userId === BO ? 'BO' : 'DI'}:${p._id.agent}=${p.costMicros}`)
      .sort()
    assert.deepEqual(pairs, [
      `ADA:claude=${microsFromUsd(8)}`,
      `ADA:copilot=${microsFromUsd(1)}`,
      'BO:qwen=0',
      `DI:gemini=${microsFromUsd(40)}`,
    ])
  })

  const [single] = await store.dailySnapshots.aggregate(
    overviewPipeline(MINE, D2, D2, dayBefore(D2)),
  )
  check('overview reads the previous day, and only that day', () => {
    assert.equal(single.totals[0].costMicros, microsFromUsd(46), 'D2: ADA 5 + 1, BO 0, DI 40')
    assert.equal(single.previous[0].costMicros, microsFromUsd(3), 'D1: ADA 3')
    assert.equal(single.previous[0].activeUsers, 1)
  })

  const [empty] = await store.dailySnapshots.aggregate(
    overviewPipeline(THEIRS, '2030-01-01' as IsoDate, '2030-01-02' as IsoDate, null),
  )
  check('overview answers an empty range with no rows rather than a zero row', () => {
    assert.deepEqual(empty.totals, [])
    assert.deepEqual(empty.byAgent, [])
  })
}

async function leaderboard(store: Store) {
  const [facet] = await store.dailySnapshots.aggregate(leaderboardPipeline(MINE, D1, D2, 100, 0))
  const users = facet.users as {
    _id: string
    totalCostMicros: number
    totalTokens: number
    sessions: number
  }[]

  check('leaderboard ranks by spend and excludes other orgs', () => {
    assert.deepEqual(
      users.map((u) => u._id),
      [DI, ADA, BO],
      'DI was inserted after ADA and BO and outspends both, so this order is the sort rather than the insertion',
    )
  })

  check('leaderboard folds a person days into one row', () => {
    const ada = users.find((u) => u._id === ADA)!
    assert.equal(ada.totalCostMicros, microsFromUsd(9))
    assert.equal(ada.totalTokens, 3_500, 'tokens, not a second reading of cost')
    assert.equal(ada.sessions, 5, 'ADA: 2 on D1 plus 3 on D2')
    // BO spent nothing and still moved seven thousand tokens. A `totalTokens`
    // that quietly summed cost would read zero here and look plausible.
    assert.equal(users.find((u) => u._id === BO)!.totalTokens, 7_000)
  })

  check('leaderboard keeps per-agent totals attached to the right person', () => {
    const agents = facet.agents as {
      _id: { userId: string; agent: string }
      tokens: number
      costMicros: number
    }[]
    const ada = agents.filter((a) => a._id.userId === ADA)
    assert.deepEqual(
      ada.map((a) => a._id.agent).sort(),
      ['claude', 'copilot'],
      'ADA never ran qwen; BO did',
    )
    const claude = ada.find((a) => a._id.agent === 'claude')!
    assert.equal(claude.costMicros, microsFromUsd(8))
    // Both columns, from one row. Every assertion here used to read costMicros
    // and none read tokens, so `tokens: {$sum: '$entries.v.costMicros'}`
    // survived every layer — on the per-agent token column the page prints.
    assert.equal(claude.tokens, 3_000)
    const freeTier = agents.find((a) => a._id.userId === BO && a._id.agent === 'qwen')!
    assert.equal(freeTier.costMicros, 0)
    assert.equal(freeTier.tokens, 7_000, 'a zero cost must not drag the token count to zero')
    assert.equal(agents.some((a) => a._id.userId === ZED), false)
  })

  const [paged] = await store.dailySnapshots.aggregate(leaderboardPipeline(MINE, D1, D2, 1, 1))
  check('leaderboard pages in the database, not in node', () => {
    assert.deepEqual(
      (paged.users as { _id: string }[]).map((u) => u._id),
      [ADA],
      'offset 1 of the spend ranking: DI, then ADA, then BO',
    )
  })

  const [top] = await store.dailySnapshots.aggregate(leaderboardPipeline(MINE, D1, D2, 1, 0))
  check('leaderboard sorts before it pages', () => {
    // DI is the last of the three inserted and the highest spender. A pipeline
    // that skips and limits an unsorted `$group` stream and sorts the page
    // afterwards returns whoever the server emitted first, which is not DI.
    assert.deepEqual(
      (top.users as { _id: string }[]).map((u) => u._id),
      [DI],
    )
  })

  check('leaderboard sees everyone in range on every page, not just that page', () => {
    // The integrity check the route runs is only page-independent if this
    // branch is. Page 1 holds ADA alone and must still carry DI's and BO's
    // ids, or an orphan sorted onto page 0 would be invisible from page 1 and
    // the request would answer 200 with a silently short ranking.
    const everyone = (paged.everyone as { ids: string[] }[])[0].ids
    assert.deepEqual([...everyone].sort(), [ADA, BO, DI].sort())
    assert.equal(everyone.includes(ZED), false)
  })
}

/**
 * The join Postgres had and MongoDB does not, in the one state where the two
 * stores disagree: an enrichment or snapshot document whose user is gone.
 *
 * Postgres could not reach that state — `claude_enrichment.user_id` and
 * `daily_snapshots.user_id` are both NOT NULL with a cascading foreign key —
 * and its inner join dropped such a row if it somehow had. MongoDB enforces
 * neither, and a half-finished Phase 7 backfill produces exactly this.
 *
 * The three routes answer differently on purpose, and this pins which is which
 * so the next person reading the diff finds a decision rather than a drift.
 */
async function orphans(store: Store) {
  const GHOST = newId<UserId>()
  await store.dailySnapshots.insertOne(snapshot(GHOST, MINE, D2, { claude: slice(100, 2) }, 1))
  await store.claudeEnrichment.insertOne(
    enrichment(GHOST, MINE, D2, {
      toolUsage: { bash: 100 },
      projectBreakdown: [project('acme/widgets', 50, 5)],
    }),
  )
  try {
    const [facet] = await store.dailySnapshots.aggregate(leaderboardPipeline(MINE, D1, D2, 1, 0))
    check('leaderboard surfaces an orphan from any page, not only the one it lands on', () => {
      const page = (facet.users as { _id: string }[]).map((u) => u._id)
      assert.deepEqual(page, [DI], 'the ghost spent less than DI, so it is not on page 0')
      const everyone = (facet.everyone as { ids: string[] }[])[0].ids
      assert.equal(everyone.includes(GHOST), true, 'and the check still sees it')
    })

    const rows = await store.claudeEnrichment.aggregate<{ tool: string; count: number }>(
      toolUsageTotals({ orgId: MINE, from: D1, to: D2 }),
    )
    check('activity counts an orphan document, where the Postgres join dropped it', () => {
      // Deliberate, and the opposite of what the leaderboard does. These two
      // routes report org-level totals and never name a person; `orgId` is on
      // the enrichment document itself, so the spend is attributable without
      // `users` and dropping it would under-report the org. The leaderboard
      // cannot do the same because its whole output is a list of names.
      assert.equal(rows.find((r) => r.tool === 'bash')!.count, 108, 'ADA 5 + 3, ghost 100')
    })

    const byPath = await store.claudeEnrichment.aggregate<{ path: string; userCount: number }>(
      projectTotals({ orgId: MINE, from: D1, to: D2 }),
    )
    check('projects counts an orphan as a person, for the same reason', () => {
      assert.equal(byPath.find((p) => p.path === 'acme/widgets')!.userCount, 3)
    })
  } finally {
    await store.dailySnapshots.deleteOne({ _id: dayKey(GHOST, D2) })
    await store.claudeEnrichment.deleteOne({ _id: dayKey(GHOST, D2) })
  }
}

async function trends(store: Store) {
  const [facet] = await store.dailySnapshots.aggregate(trendsPipeline(MINE, D1, D2))
  const days = facet.days as { _id: string; totalCostMicros: number; totalTokens: number }[]

  check('trends returns one point per day, in date order', () => {
    assert.deepEqual(
      days.map((d) => d._id),
      [D1, D2],
    )
    assert.equal(days[0].totalCostMicros, microsFromUsd(3))
    assert.equal(days[1].totalCostMicros, microsFromUsd(46), 'ADA 5 + 1, BO 0, DI 40')
    // The token series on the same chart. Nothing read it before, and a
    // `totalTokens` summing callCount or cost survived every layer.
    assert.equal(days[0].totalTokens, 1_000)
    assert.equal(days[1].totalTokens, 13_500, 'ADA 2500, BO 7000, DI 4000')
  })

  check('trends keeps each day per-agent split on its own day', () => {
    const agents = facet.agents as {
      _id: { date: string; agent: string }
      tokens: number
      costMicros: number
    }[]
    const d1 = agents.filter((a) => a._id.date === D1)
    assert.deepEqual(
      d1.map((a) => a._id.agent),
      ['claude'],
      'only ADA worked on D1, on claude alone',
    )
    assert.equal(d1[0].costMicros, microsFromUsd(3))
    assert.equal(d1[0].tokens, 1_000, 'tokens, not a second reading of cost')
    const qwen = agents.find((a) => a._id.date === D2 && a._id.agent === 'qwen')!
    assert.equal(qwen.costMicros, 0)
    assert.equal(qwen.tokens, 7_000, 'a free tier reports tokens at zero cost')
    assert.equal(agents.some((a) => a._id.date === D3), false)
  })

  check('trends draws no point for a day nobody worked', () => {
    assert.equal(
      days.some((d) => d._id === D3),
      false,
      'a gap is not a zero: one means no data, the other means no spend',
    )
  })
}

async function activity(store: Store) {
  const rows = await store.claudeEnrichment.aggregate<{
    tool: string
    count: number
    category: string
  }>(toolUsageTotals({ orgId: MINE, from: D1, to: D2 }))

  check('activity sums each tool across people and days, most used first', () => {
    assert.deepEqual(rows, [
      { tool: 'bash', count: 8, category: 'tool' }, // ADA 5 on D1 plus 3 on D2
      { tool: 'neon', count: 7, category: 'mcp' }, // ADA 6 plus BO 1
      { tool: 'git', count: 5, category: 'shell' }, // ADA 1 on D1 plus 4 on D2
      { tool: 'edit', count: 2, category: 'tool' },
      { tool: 'git', count: 2, category: 'tool' }, // the same name, a different category
    ])
  })

  check('activity leaves another org tools out', () => {
    // ZED alone ran bash 1,000 times on D1.
    assert.equal(rows.find((r) => r.tool === 'bash')!.count, 8)
  })

  check('activity treats a null usage map as contributing nothing', () => {
    // BO's toolUsage and shellUsage are null; only his mcpUsage is counted, and
    // the document is not dropped on account of the other two.
    assert.equal(rows.find((r) => r.tool === 'neon')!.count, 7)
  })

  check('activity treats an empty usage map as contributing nothing either', () => {
    // DI's toolUsage and shellUsage are `{}` rather than null — a distinction
    // the node merge's `?? {}` could not make, and the one deleted assertion
    // from that suite no fixture replaced. Neither adds a row, and neither
    // drops DI's document on the way past.
    assert.equal(rows.some((r) => r.count === 0), false)
    assert.deepEqual(rows.map((r) => r.tool), ['bash', 'neon', 'git', 'edit', 'git'])
  })
}

async function projects(store: Store) {
  const rows = await store.claudeEnrichment.aggregate<{
    path: string
    remote: string | null
    totalCost: number
    totalSessions: number
    userCount: number
  }>(projectTotals({ orgId: MINE, from: D1, to: D2 }))

  check('projects folds cost and sessions across people and days', () => {
    assert.deepEqual(rows, [
      // ADA 4 + 6, BO 2 — and none of ZED's 500.
      { path: 'acme/widgets', remote: null, totalCost: 12, totalSessions: 6, userCount: 2 },
      { path: 'api', remote: 'github.com/one/api', totalCost: 3, totalSessions: 1, userCount: 1 },
      { path: 'api', remote: 'github.com/two/api', totalCost: 2, totalSessions: 1, userCount: 1 },
      { path: 'acme/gadgets', remote: null, totalCost: 1, totalSessions: 1, userCount: 1 },
    ])
  })


  check('projects counts people, not user-days or days', () => {
    // ADA touched acme/widgets on both days, so counting documents answers 3
    // and counting distinct dates answers 2. Only counting people answers 2
    // for a reason, and BO's single day is what tells the last two apart.
    assert.equal(rows[0].userCount, 2)
    assert.equal(rows[3].userCount, 1, 'acme/gadgets is ADA alone, on one day')
  })

  check('projects treats an empty breakdown as contributing nothing', () => {
    // DI's projectBreakdown is `[]`, in range. `$unwind` drops the document
    // rather than inventing a row with an undefined path — the second deleted
    // assertion from the node-merge suite.
    assert.equal(rows.length, 4)
    assert.equal(rows.some((r) => r.path === undefined || r.path === null), false)
  })

  const versions = await store.claudeEnrichment
    .aggregate<{ _id: string; n: number }>([
      { $match: { orgId: MINE, claudeVersions: { $ne: null } } },
      { $project: { kv: { $objectToArray: '$claudeVersions' } } },
      { $unwind: '$kv' },
      { $group: { _id: '$kv.k', n: { $sum: '$kv.v' } } },
      { $sort: { _id: 1 } },
    ])
  check('dotted version keys are stored and read back whole', () => {
    assert.deepEqual(versions, [
      { _id: '2.1.330', n: 3 },
      { _id: '2.1.99', n: 1 },
    ])
  })
}

async function adminUsers(store: Store) {
  const rows = await store.users.aggregate<AdminUserRow>(adminUsersPipeline(MINE))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const createdAt = (id: UserId) => USERS.find((u) => u._id === id)!.createdAt.toISOString()

  check('admin users lists the org, never the other one', () => {
    assert.deepEqual([...byId.keys()].sort(), [ADA, BO, CY, DI].sort())
  })

  check('admin users returns exactly the AdminUserRow keys, in order', () => {
    for (const r of rows) {
      assert.deepEqual(Object.keys(r), [
        'id', 'name', 'email', 'role', 'isActive', 'createdAt', 'deviceCount', 'hostnames',
        'lastSeenAt', 'lastSyncDate', 'totalCostUsd', 'totalTokens', 'activeDays',
      ])
    }
  })

  check('admin users sums snapshots without multiplying by devices', () => {
    // ADA owns two devices; a join that multiplied rows would double these.
    assert.deepEqual(byId.get(ADA), {
      id: ADA,
      name: 'Ada',
      email: 'ada@example.invalid',
      role: 'developer',
      isActive: true,
      createdAt: createdAt(ADA),
      deviceCount: 2,
      hostnames: ['alpha', 'zeta'],
      // The later device, to the second, like Postgres' to_char.
      lastSeenAt: '2026-06-02T10:00:00Z',
      lastSyncDate: D2,
      totalCostUsd: 9,
      totalTokens: 3_500,
      activeDays: 2,
    })
  })

  check('admin users zero-fills a user with no devices', () => {
    assert.deepEqual(byId.get(BO), {
      id: BO,
      name: 'Bo',
      email: 'bo@example.invalid',
      role: 'developer',
      isActive: true,
      createdAt: createdAt(BO),
      deviceCount: 0,
      hostnames: [],
      lastSeenAt: null,
      lastSyncDate: D2,
      totalCostUsd: 0,
      totalTokens: 7_000,
      activeDays: 1,
    })
    assert.equal(byId.get(CY)!.lastSyncDate, D3)
    assert.equal(byId.get(DI)!.totalCostUsd, 40)
  })

  // A user with no snapshots at all, the "has not onboarded" case.
  const NEW = newId<UserId>()
  await store.users.insertOne(user(NEW, MINE, 'Neo'))
  const [fresh] = (await store.users.aggregate<AdminUserRow>(adminUsersPipeline(MINE))).filter(
    (r) => r.id === NEW,
  )
  await store.users.deleteOne({ _id: NEW })
  check('admin users zero-fills a user who never synced', () => {
    assert.equal(fresh.deviceCount, 0)
    assert.equal(fresh.lastSyncDate, null)
    assert.equal(fresh.totalCostUsd, 0)
    assert.equal(fresh.totalTokens, 0)
    assert.equal(fresh.activeDays, 0)
  })
}

async function adoptionFunnel(store: Store) {
  // An inactive user with usage, and a zero-token day before BO's first real one.
  const NEO = newId<UserId>()
  await store.users.insertOne({ ...user(NEO, MINE, 'Neo'), isActive: false })
  await store.dailySnapshots.insertOne(snapshot(NEO, MINE, D1, { claude: slice(500, 1) }, 1))
  await store.dailySnapshots.insertOne(snapshot(BO, MINE, D1, { qwen: slice(0, 0) }, 1))
  const rows = await store.users.aggregate(funnelUsersPipeline(MINE, D1, D2))
  const scoped = await store.users.aggregate(funnelUsersPipeline(MINE, D1, D2, [ADA, ZED]))
  await store.dailySnapshots.deleteMany({ userId: { $in: [NEO, BO] }, date: D1 })
  await store.users.deleteOne({ _id: NEO })

  const facts = (id: UserId) => {
    const r = rows.find((x) => x.userId === id)!
    return [r.hasDevice, r.firstSync, r.lastSync, r.activeDays]
  }
  check('adoption funnel: active users of the org only, scope narrows', () => {
    assert.deepEqual(rows.map((r) => r.userId).sort(), [ADA, BO, CY, DI].sort())
    assert.deepEqual(scoped.map((r) => r.userId), [ADA])
  })
  check('adoption funnel: device, first and last sync, active days in range, zero-token days ignored', () => {
    assert.deepEqual(facts(ADA), [true, D1, D2, 2], 'two devices still one flag; two days in range')
    assert.deepEqual(facts(BO), [false, D2, D2, 1], 'the zero-token D1 is not a sync')
    assert.deepEqual(facts(CY), [false, D3, D3, 0], 'synced, but after the range')
    assert.deepEqual(facts(DI), [true, D2, D2, 1])
  })
}

async function adminDevices(store: Store) {
  const rows = await store.users.aggregate<AdminDeviceRow>(adminDevicesPipeline(MINE))

  check('admin devices lists the org newest first, with revoked derived from tokens', () => {
    assert.deepEqual(rows, [
      { id: DI_BOX, hostname: 'di-box', platform: 'darwin', lastSeenAt: '2026-06-03T00:00:00Z', userName: 'Di', userEmail: 'di@example.invalid', revoked: true },
      { id: ZETA, hostname: 'zeta', platform: 'darwin', lastSeenAt: '2026-06-02T10:00:00Z', userName: 'Ada', userEmail: 'ada@example.invalid', revoked: true },
      { id: ALPHA, hostname: 'alpha', platform: 'darwin', lastSeenAt: '2026-06-01T08:00:00Z', userName: 'Ada', userEmail: 'ada@example.invalid', revoked: false },
    ])
  })
}

async function seats(store: Store) {
  const seated = await seatedKeys(store, MINE)
  const all = await monthToDateSpend(store, MINE, null, null, D3, seated)
  const claude = await monthToDateSpend(store, MINE, null, 'claude', D3, seated)
  const copilot = await monthToDateSpend(store, MINE, ADA, 'copilot', D3, seated)
  check('month-to-date API spend leaves seated pairs out, and other orgs too', () => {
    // DI's gemini seat starts D3, after the D2 usage; it is still seated (a known limit).
    assert.equal(all, microsFromUsd(12), 'June 60 in MINE, less ADA claude 8 and DI gemini 40')
    assert.equal(claude, 0, 'ADA claude is the only claude, and it is seated')
    assert.equal(copilot, microsFromUsd(1), 'ADA copilot is not seated')
  })

  const idle = await idleSeats(store, MINE, null, null, 2, D3)
  check('idle seats: no tokens on that agent in the window, young seats skipped, org-scoped', () => {
    assert.deepEqual(idle.map((s) => s._id), [seatKey(CY, 'claude')])
  })

  const lastUsed = await seatLastUsed(store, MINE, [ADA, BO, CY, ZED])
  check('seat last used: max date per (user, agent), other orgs out', () => {
    assert.deepEqual(
      Object.fromEntries(lastUsed),
      {
        [seatKey(ADA, 'claude')]: D2,
        [seatKey(ADA, 'copilot')]: D2,
        [seatKey(BO, 'qwen')]: D2, // tokens at $0 still count as use
        [seatKey(CY, 'codex')]: D3,
      },
      'CY never ran claude, so CY:claude is absent; ZED is another org',
    )
  })

  const orgHits = await limitHitsThisMonth(store, MINE, null, D3)
  const adaHits = await limitHitsThisMonth(store, MINE, ADA, D3)
  check('limit hits sum this month, null days as 0, other orgs out', () => {
    assert.equal(orgHits, 3)
    assert.equal(adaHits, 2)
  })
}

async function rateLimit(store: Store) {
  const hit = () => store.rateLimits.findOneAndUpdate({ _id: RATE_KEY }, hitPipeline(60_000), { upsert: true })

  const first = await hit()
  const second = await hit()
  check('rate limit starts a window at 1 and counts within it', () => {
    assert.equal(first!.count, 1)
    assert.equal(second!.count, 2)
    assert.equal(second!.expiresAt.getTime(), first!.expiresAt.getTime(), 'the window keeps its end')
    const left = first!.expiresAt.getTime() - Date.now()
    assert.ok(left > 50_000 && left <= 60_000, `window of ${left}ms`)
  })

  await store.rateLimits.updateOne({ _id: RATE_KEY }, { $set: { expiresAt: new Date(Date.now() - 1) } })
  const reset = await hit()
  check('rate limit starts a fresh window once the old one closed', () => {
    assert.equal(reset!.count, 1)
    assert.ok(reset!.expiresAt.getTime() > Date.now())
  })
}

async function main() {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI is not set')
  if (process.env.BW_DASHBOARD_ALLOW_WRITES !== '1') {
    throw new Error('refusing to write: set BW_DASHBOARD_ALLOW_WRITES=1, and point at a throwaway database')
  }

  const client = new MongoClient(uri)
  await client.connect()
  const store = storeFor(client)
  try {
    await syncSchema(client.db())
    // Before as well as after: a run killed partway through leaves its
    // documents behind, and the next run would insert onto them and report
    // sums that are right about a state no assertion describes.
    await clean(store)
    await seed(store)
    await overview(store)
    await leaderboard(store)
    await trends(store)
    await activity(store)
    await projects(store)
    await orphans(store)
    await adminUsers(store)
    await adoptionFunnel(store)
    await adminDevices(store)
    await seats(store)
    await rateLimit(store)
  } finally {
    await clean(store)
    await client.close()
  }

  for (const what of checks) console.log(`  ok  ${what}`)
  console.log(`PASS: ${checks.length} checks against a real server, with two orgs seeded`)
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exit(1)
})
