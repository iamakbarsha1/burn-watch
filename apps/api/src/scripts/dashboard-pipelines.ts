/**
 * The five dashboard aggregations, run against a real MongoDB, checked against
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
import type { ProjectEntry } from '@burn-watch/shared'
import {
  dayKey,
  microsFromUsd,
  newId,
  storeFor,
  syncSchema,
  type ClaudeEnrichmentDoc,
  type DailySnapshotDoc,
  type IsoDate,
  type OrgId,
  type Store,
  type UserId,
} from '@burn-watch/db'
import { toolUsageTotals } from '../routes/dashboard/activity.js'
import { leaderboardPipeline } from '../routes/dashboard/leaderboard.js'
import { dayBefore } from '../routes/dashboard/dates.js'
import { overviewPipeline } from '../routes/dashboard/overview.js'
import { projectTotals } from '../routes/dashboard/projects.js'
import { trendsPipeline } from '../routes/dashboard/trends.js'

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

const project = (path: string, cost: number, sessions: number): ProjectEntry => ({
  path,
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
    Pick<ClaudeEnrichmentDoc, 'toolUsage' | 'shellUsage' | 'mcpUsage' | 'projectBreakdown'>
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
    mcpUsage: { neon: 1 },
    projectBreakdown: [project('acme/widgets', 2, 1)],
  }),
  // Empty rather than null, and in range: `{}` and `[]` are the cases the
  // deleted node-merge tests covered and no fixture reached afterwards.
  enrichment(DI, MINE, D2, { toolUsage: {}, shellUsage: {}, projectBreakdown: [] }),
  enrichment(CY, MINE, D3, { toolUsage: { bash: 999 } }),
  enrichment(ZED, THEIRS, D1, {
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
}

async function clean(store: Store) {
  const orgs = { orgId: { $in: [MINE, THEIRS] } }
  await store.dailySnapshots.deleteMany(orgs)
  await store.claudeEnrichment.deleteMany(orgs)
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
    totalCost: number
    totalSessions: number
    userCount: number
  }>(projectTotals({ orgId: MINE, from: D1, to: D2 }))

  check('projects folds cost and sessions across people and days', () => {
    assert.deepEqual(rows, [
      // ADA 4 + 6, BO 2 — and none of ZED's 500.
      { path: 'acme/widgets', totalCost: 12, totalSessions: 6, userCount: 2 },
      { path: 'acme/gadgets', totalCost: 1, totalSessions: 1, userCount: 1 },
    ])
  })

  check('projects counts people, not user-days or days', () => {
    // ADA touched acme/widgets on both days, so counting documents answers 3
    // and counting distinct dates answers 2. Only counting people answers 2
    // for a reason, and BO's single day is what tells the last two apart.
    assert.equal(rows[0].userCount, 2)
    assert.equal(rows[1].userCount, 1, 'acme/gadgets is ADA alone, on one day')
  })

  check('projects treats an empty breakdown as contributing nothing', () => {
    // DI's projectBreakdown is `[]`, in range. `$unwind` drops the document
    // rather than inventing a row with an undefined path — the second deleted
    // assertion from the node-merge suite.
    assert.equal(rows.length, 2)
    assert.equal(rows.some((r) => r.path === undefined || r.path === null), false)
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
