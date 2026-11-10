/**
 * BW-41 repro on MongoDB. Two concurrent rebuilds of one (user, date), each in
 * its own transaction on its own client, asserting the stored snapshot ends up
 * holding both writers' tokens.
 *
 * Deliberately not part of `npm test`. Transactions need a replica set, and the
 * defect is two transactions whose reads overlap, which no in-memory fake can
 * model. `scripts/local-replset.sh up` prints a URI for a disposable single-node
 * set.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27117/burnwatch_race?replicaSet=rs0 \
 *     BW41_ALLOW_WRITES=1 npx tsx src/scripts/snapshot-race.ts
 *
 * It creates its own user documents and deletes them on the way out, so it
 * never reads or writes a document it did not make. Point it at a throwaway
 * database anyway.
 *
 * Two regimes per run, BW41_ROUNDS each (default 5): a fresh day, where both
 * writers race to insert the snapshot document, and a seeded day, where it
 * already exists and both race to update it. The losing writer's error is
 * recorded per round and summarised at the end, because which one MongoDB
 * raises (WriteConflict or DuplicateKey) decides whether runInTxn's 11000
 * fallback is load-bearing or dead.
 *
 * BW41_MODE=stale-retry makes the losing writer's retry re-issue only the
 * snapshot write, with the total it computed before the conflict, instead of
 * re-running the whole body. That is the bug class runInTxn's whole-body re-run
 * exists to rule out, and in that mode the run must LOSE tokens every round. It
 * is how we know the barrier produces a real race rather than a lucky ordering.
 */
import { strict as assert } from 'node:assert'
import { MongoClient, MongoError, MongoServerError } from 'mongodb'
import type { UsageEvent } from '@burn-watch/shared'
import { dayKey, newId, type IsoDate, type Micros, type OrgId, type UserId } from '../ids.js'
import { agentSourceTotalsPipeline, rebuildDailySnapshot } from '../snapshot.js'
import { runInTxn, storeFor, type Store, type Txn } from '../store.js'
import { upsertUsageEvents } from '../usage.js'

const DATE = '2026-01-15' as IsoDate
const TOKENS_PER_WRITER = 1000
const WRITERS = 2
const ROUNDS = Number(process.env.BW41_ROUNDS ?? 5)
const MODE: 'whole-body' | 'stale-retry' =
  process.env.BW41_MODE === 'stale-retry' ? 'stale-retry' : 'whole-body'

interface LoserError {
  code: number | string | undefined
  codeName: string | undefined
  labels: string[]
}

interface RoundResult {
  stored: number
  held: number
  attempts: number[]
  losers: LoserError[]
}

function describeError(err: unknown): LoserError {
  if (err instanceof MongoError) {
    const codeName = err instanceof MongoServerError ? err.codeName : undefined
    return { code: err.code, codeName, labels: [...err.errorLabels] }
  }
  return { code: undefined, codeName: err instanceof Error ? err.message : String(err), labels: [] }
}

const describeKey = (e: LoserError) => `${e.code} ${e.codeName} [${e.labels.join(',')}]`

/**
 * Releases once every writer has upserted its event and none has committed.
 *
 * Without it the two transactions would almost always serialise by luck and the
 * run would pass against a broken runInTxn, which is the failure mode that
 * makes a race test worthless. A writer whose first attempt never arrives
 * (an error before the barrier) would hang the other forever, so the wait
 * fails loudly instead.
 */
function barrier(parties: number, timeoutMs = 10_000) {
  let arrived = 0
  let release!: () => void
  const open = new Promise<void>((resolve, reject) => {
    release = resolve
    setTimeout(
      () => reject(new Error(`barrier: only ${arrived}/${parties} writers arrived within ${timeoutMs}ms`)),
      timeoutMs,
    ).unref()
  })
  return () => {
    if (++arrived === parties) release()
    return open
  }
}

function event(modelName: string): UsageEvent {
  return {
    agent: 'claude',
    date: DATE,
    modelName,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalTokens: TOKENS_PER_WRITER,
    costUsd: 1,
    isFreeTier: false,
  }
}

async function totalTokensSeen(tx: Txn, userId: UserId): Promise<number> {
  const rows = await tx.usageEvents.aggregate<{ tokens: number }>(agentSourceTotalsPipeline(userId, DATE))
  return rows.reduce((sum, r) => sum + r.tokens, 0)
}

async function race(writers: Store[], control: Store, seedSnapshot: boolean): Promise<RoundResult> {
  const userId = newId<UserId>()
  const orgId = newId<OrgId>()
  await control.users.insertOne({
    _id: userId,
    orgId,
    email: `bw41-${userId}@example.invalid`,
    name: 'BW-41 repro',
    githubUsername: null,
    role: 'developer',
    isActive: true,
    createdAt: new Date(),
  })
  if (seedSnapshot) {
    await control.dailySnapshots.insertOne({
      _id: dayKey(userId, DATE),
      userId,
      orgId,
      date: DATE,
      byAgent: {},
      totalTokens: 0,
      totalCostMicros: 0 as Micros,
      callCount: 0,
      sessionCount: 0,
      cacheHitRate: null,
      modelsUsed: [],
      updatedAt: new Date(),
    })
  }

  try {
    const reach = barrier(WRITERS)
    const attempts = writers.map(() => 0)
    const losers: LoserError[] = []
    // What each writer's first attempt computed, replayed by the stale-retry mode.
    const firstTotal = writers.map(() => 0)

    await Promise.all(
      writers.map((store, i) =>
        runInTxn(store, async (tx) => {
          attempts[i]++
          // Distinct per writer so the two rows do not collide on the unique
          // key and the aggregate has something to lose.
          await upsertUsageEvents(tx, userId, orgId, null, DATE, [event(`bw41-writer-${i}`)])
          // First attempt only. A retried body must not wait on a barrier that
          // has already opened and will never count a second arrival.
          if (attempts[i] === 1) {
            firstTotal[i] = await totalTokensSeen(tx, userId)
            await reach()
          }
          try {
            if (MODE === 'stale-retry' && attempts[i] > 1) {
              await tx.dailySnapshots.updateOne(
                { _id: dayKey(userId, DATE) },
                { $set: { userId, orgId, date: DATE, totalTokens: firstTotal[i], updatedAt: new Date() } },
                { upsert: true },
              )
            } else {
              await rebuildDailySnapshot(tx, userId, DATE)
            }
          } catch (err) {
            losers.push(describeError(err))
            throw err
          }
        }),
      ),
    )

    const snapshot = await control.dailySnapshots.findOne({ _id: dayKey(userId, DATE) })
    const [heldRow] = await control.usageEvents.aggregate<{ total: number }>([
      { $match: { userId, date: DATE } },
      { $group: { _id: null, total: { $sum: '$totalTokens' } } },
    ])
    return { stored: snapshot?.totalTokens ?? 0, held: heldRow?.total ?? 0, attempts, losers }
  } finally {
    // Caught and logged rather than thrown, so a cleanup failure never replaces
    // the assertion as the error that surfaces.
    try {
      await control.usageEvents.deleteMany({ userId })
      await control.dailySnapshots.deleteMany({ userId })
      await control.users.deleteOne({ _id: userId })
    } catch (error) {
      console.error('cleanup failed, leaving documents behind:', error)
    }
  }
}

async function main() {
  const uri = process.env.MONGODB_URI
  assert(uri, 'MONGODB_URI is required')
  assert(
    process.env.BW41_ALLOW_WRITES === '1',
    'This script writes. Set BW41_ALLOW_WRITES=1 once MONGODB_URI points somewhere disposable.',
  )

  const clients = Array.from({ length: WRITERS + 1 }, () => new MongoClient(uri))
  const [controlClient, ...writerClients] = clients
  const control = storeFor(controlClient)
  const writers = writerClients.map((c) => storeFor(c))

  // Production collections exist before any transaction touches them. Without
  // this, the first-ever rebuild creates dailySnapshots implicitly inside its
  // transaction and the loser's conflict surfaces at commit, invisible to the
  // body, which is a different experiment from the one this script runs.
  const db = controlClient.db()
  for (const name of ['users', 'usageEvents', 'dailySnapshots']) {
    await db.createCollection(name).catch((err: unknown) => {
      if (!(err instanceof MongoServerError && err.codeName === 'NamespaceExists')) throw err
    })
  }
  // The index the two-tier upsert relies on in production, so the write path
  // under test is the real one.
  await db
    .collection('usageEvents')
    .createIndex(
      { userId: 1, date: 1, agent: 1, modelName: 1, deviceId: 1, source: 1 },
      { unique: true, name: 'usageEvents_key' },
    )

  const expected = TOKENS_PER_WRITER * WRITERS
  const seen = new Map<string, number>()
  let lostRounds = 0
  let failures = 0

  try {
    for (const seedSnapshot of [false, true]) {
      const regime = seedSnapshot ? 'seeded day' : 'fresh day '
      for (let round = 1; round <= ROUNDS; round++) {
        const r = await race(writers, control, seedSnapshot)
        // A retry the body never saw an error for was raised by the commit
        // itself (withTransaction retries those too), so name it rather than
        // print a retry with no loser.
        const retries = r.attempts.reduce((n, a) => n + a - 1, 0)
        for (let i = r.losers.length; i < retries; i++) {
          r.losers.push({ code: undefined, codeName: 'retried at commit, error not visible to the body', labels: [] })
        }
        for (const l of r.losers) seen.set(describeKey(l), (seen.get(describeKey(l)) ?? 0) + 1)
        const loserText = r.losers.map(describeKey).join('; ') || 'none'
        console.log(
          `${regime} round ${round}: stored ${r.stored} / held ${r.held}, attempts [${r.attempts}], loser: ${loserText}`,
        )
        assert.equal(r.held, expected, `usageEvents should hold both writers' rows, held ${r.held}`)
        if (r.stored !== r.held) lostRounds++
        if (MODE === 'whole-body') {
          if (r.stored !== expected) failures++
          // One writer must have retried, or the transactions never overlapped
          // and this round proved nothing.
          if (Math.max(...r.attempts) < 2) {
            failures++
            console.error(`  no writer retried in this round: the barrier did not produce overlapping transactions`)
          }
        }
      }
    }
  } finally {
    await Promise.all(clients.map((c) => c.close()))
  }

  console.log(`\nloser errors seen: ${JSON.stringify(Object.fromEntries(seen))}`)
  const total = ROUNDS * 2
  if (MODE === 'stale-retry') {
    console.log(`stale-retry: the snapshot lost a writer in ${lostRounds}/${total} rounds`)
    assert.equal(
      lostRounds,
      total,
      `stale-retry must lose tokens every round; ${total - lostRounds} round(s) did not, so the barrier is not producing contention`,
    )
    console.log('PASS: the instrument detects a retry that skips the recompute')
    return
  }
  assert.equal(failures, 0, `${failures} round(s) failed`)
  console.log(`PASS: ${total} rounds, ${WRITERS} concurrent rebuilds converged on ${expected} every time`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
