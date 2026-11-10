/**
 * BW-41 repro. Two concurrent rebuilds of one (user, date) against a real
 * Postgres, asserting the snapshot ends up holding both writers' rows.
 *
 * Deliberately not part of `npm test`. The suite's fake Drizzle resolves every
 * query inline, so it cannot model two transactions whose reads overlap, which
 * is the entire defect. Proving this one needs a live database and a barrier
 * that holds both writers at the point where their snapshots diverge.
 *
 *   DATABASE_URL=<throwaway branch> BW41_ALLOW_WRITES=1 \
 *     npx tsx src/scripts/bw41-snapshot-race.ts
 *
 * It creates its own organization and deletes it on the way out, so it never
 * reads or writes a row it did not make. Point it at a branch anyway.
 */
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Pool } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-serverless'
import * as schema from '../../drizzle/schema.js'
import { organizations, users, usageEvents, dailySnapshots } from '../../drizzle/schema.js'
import { rebuildDailySnapshot } from '../services/snapshot.service.js'

const DATE = '2026-01-15'
const TOKENS_PER_WRITER = 1000
const WRITERS = 2

function connect(connectionString: string) {
  const pool = new Pool({ connectionString })
  return { pool, db: drizzle(pool, { schema }) }
}

/**
 * Releases once every writer has inserted its row and none has committed.
 *
 * Without it the two transactions would almost always serialise by luck and the
 * run would pass against unfixed code, which is the failure mode that makes a
 * race test worthless.
 */
function barrier(parties: number) {
  let arrived = 0
  let release!: () => void
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  return () => {
    if (++arrived === parties) release()
    return open
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL
  assert(connectionString, 'DATABASE_URL is required')
  assert(
    process.env.BW41_ALLOW_WRITES === '1',
    'This script writes. Set BW41_ALLOW_WRITES=1 once DATABASE_URL points somewhere disposable.',
  )

  const writers = Array.from({ length: WRITERS }, () => connect(connectionString))
  const control = connect(connectionString)

  const [org] = await control.db
    .insert(organizations)
    .values({ name: 'BW-41 repro', slug: `bw41-${randomUUID()}` })
    .returning()
  const [user] = await control.db
    .insert(users)
    .values({
      orgId: org.id,
      email: `bw41-${randomUUID()}@example.invalid`,
      name: 'BW-41 repro',
    })
    .returning()

  try {
    const reach = barrier(WRITERS)

    await Promise.all(
      writers.map((conn, i) =>
        conn.db.transaction(async (tx) => {
          await tx.insert(usageEvents).values({
            userId: user.id,
            deviceId: null,
            agent: 'claude',
            date: DATE,
            // Distinct per writer so the two rows do not collide on the unique
            // key and the aggregate has something to lose.
            modelName: `bw41-writer-${i}`,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreateTokens: 0,
            cacheReadTokens: 0,
            totalTokens: TOKENS_PER_WRITER,
            costUsd: '1.000000',
            isFreeTier: false,
          })
          await reach()
          await rebuildDailySnapshot(tx, user.id, DATE)
        }),
      ),
    )

    const [snapshot] = await control.db
      .select({ totalTokens: dailySnapshots.totalTokens })
      .from(dailySnapshots)
      .where(eq(dailySnapshots.userId, user.id))

    const expected = TOKENS_PER_WRITER * WRITERS
    const stored = snapshot?.totalTokens ?? 0

    console.log(`usage_events hold:            ${expected}`)
    console.log(`daily_snapshots.total_tokens: ${stored}`)

    assert.equal(
      stored,
      expected,
      `snapshot lost a concurrent writer: stored ${stored}, usage_events hold ${expected}`,
    )
    console.log(`PASS: ${WRITERS} concurrent rebuilds converged on ${expected}`)
  } finally {
    // Caught and logged rather than thrown. A failure here would replace the
    // assertion above as the error that surfaces, which is how the first run of
    // this script reported a foreign key complaint instead of the race it had
    // just caught.
    try {
      // `daily_snapshots.org_id` references organizations without a cascade, so
      // the snapshot this script provoked has to go before its organization can.
      await control.db.delete(dailySnapshots).where(eq(dailySnapshots.userId, user.id))
      await control.db.delete(usageEvents).where(eq(usageEvents.userId, user.id))
      await control.db.delete(organizations).where(eq(organizations.id, org.id))
    } catch (error) {
      console.error('cleanup failed, leaving rows behind:', error)
    }
    await Promise.all([...writers.map((w) => w.pool.end()), control.pool.end()])
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
