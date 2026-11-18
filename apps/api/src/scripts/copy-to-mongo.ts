/**
 * Copies every Postgres table into MongoDB. Run once at cutover. Safe to rerun:
 * each document is upserted, so a second run makes Mongo match Postgres again.
 *
 * Run `npm run sync -w @burn-watch/db` against the same MONGODB_URI first, so
 * the collections and unique indexes exist before any document lands.
 *
 *   DATABASE_URL=postgresql://… MONGODB_URI=mongodb+srv://…/burnwatch \
 *     npm run copy-to-mongo -w @burn-watch/api              # dry run: counts only
 *   … npm run copy-to-mongo -w @burn-watch/api -- --write   # copy, then verify
 *
 * Not copied: rate_limits (short-lived windows, Mongo's TTL index rebuilds
 * them) and drizzle's __drizzle_migrations.
 *
 * better-auth's tables (user, session, account, verification) go across under
 * their own names with `_id` = the Postgres id string. The dashboard must set
 * `advanced.database.generateId` to a function when it switches to
 * mongodbAdapter, or the adapter tries to read those ids as ObjectIds.
 */
process.env.TZ = 'UTC' // raw pg reads of `timestamp` columns parse in local time otherwise

import 'dotenv/config'
import { strict as assert } from 'node:assert'
import { Pool } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-serverless'
import type { AnyBulkWriteOperation, Document } from 'mongodb'
import { getClient, getDb, type OrgId } from '@burn-watch/db'
import * as pg from '../../drizzle/schema.js'
import * as map from './copy-to-mongo.map.js'

const AUTH_TABLES = ['user', 'session', 'account', 'verification'] as const

async function main() {
  assert(process.env.DATABASE_URL, 'DATABASE_URL is required')
  assert(process.env.MONGODB_URI, 'MONGODB_URI is required')
  const write = process.argv.includes('--write')

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool, { schema: pg })
  const mongo = getDb()
  assert(mongo.databaseName !== 'test', 'MONGODB_URI names no database; append /burnwatch')

  try {
    const users = await db.select().from(pg.users)
    const orgOf = new Map(users.map((u) => [u.id, u.orgId as OrgId]))
    const org = (userId: string) => {
      const o = orgOf.get(userId)
      assert(o, `row points at unknown user ${userId}`)
      return o
    }

    // Each plan entry: target collection, documents, and how to find an existing one.
    const plan: { coll: string; docs: Document[]; key: (d: Document) => Document }[] = []
    const byId = (d: Document): Document => ({ _id: d._id })
    const add = (coll: string, docs: Document[], key = byId) => plan.push({ coll, docs, key })

    add('organizations', (await db.select().from(pg.organizations)).map(map.orgDoc))
    add('users', users.map(map.userDoc))
    add('devices', (await db.select().from(pg.devices)).map(map.deviceDoc))
    add('deviceTokens', (await db.select().from(pg.deviceTokens)).map(map.deviceTokenDoc))
    add('pendingDevices', (await db.select().from(pg.pendingDevices)).map(map.pendingDeviceDoc))
    add('invites', (await db.select().from(pg.invites)).map(map.inviteDoc))
    add('orgIntegrations', (await db.select().from(pg.orgIntegrations)).map(map.orgIntegrationDoc))
    add('budgetAlerts', (await db.select().from(pg.budgetAlerts)).map(map.budgetAlertDoc))
    add(
      'usageEvents',
      (await db.select().from(pg.usageEvents)).map((r) => map.usageEventDoc(r, org(r.userId))),
      // The unique index usageEvents_key, so a rerun replaces instead of duplicating.
      (d) => ({
        userId: d.userId,
        date: d.date,
        agent: d.agent,
        modelName: d.modelName,
        deviceId: d.deviceId,
        source: d.source,
      }),
    )
    add(
      'claudeEnrichment',
      (await db.select().from(pg.claudeEnrichment)).map((r) => map.enrichmentDoc(r, org(r.userId))),
    )
    add('dailySnapshots', (await db.select().from(pg.dailySnapshots)).map(map.snapshotDoc))
    for (const t of AUTH_TABLES) {
      const { rows } = await pool.query(`select * from "${t}"`)
      add(t, rows.map(({ id, ...rest }: Document) => ({ _id: id, ...rest })))
    }

    for (const p of plan) console.log(`${p.coll.padEnd(18)} ${p.docs.length}`)
    if (!write) {
      console.log('dry run. pass --write to copy.')
      return
    }

    for (const p of plan) {
      if (p.docs.length === 0) continue
      const ops: AnyBulkWriteOperation<Document>[] = p.docs.map((d) => {
        const { _id, ...rest } = d
        // usageEvents carries no _id, so a new one gets an ObjectId and an old one keeps its own.
        return { replaceOne: { filter: p.key(d), replacement: _id === undefined ? rest : d, upsert: true } }
      })
      const r = await mongo.collection(p.coll).bulkWrite(ops, { ordered: true })
      console.log(`${p.coll.padEnd(18)} inserted ${r.upsertedCount}, replaced ${r.matchedCount}`)
    }

    // Verify: every collection holds at least the Postgres row count, and
    // money totals match to the micro-dollar.
    let ok = true
    for (const p of plan) {
      const n = await mongo.collection(p.coll).countDocuments()
      if (n < p.docs.length) {
        ok = false
        console.error(`MISMATCH ${p.coll}: postgres ${p.docs.length}, mongo ${n}`)
      }
    }
    const sum = async (coll: string, field: string) => {
      const [r] = await mongo.collection(coll).aggregate([{ $group: { _id: null, s: { $sum: `$${field}` } } }]).toArray()
      return r?.s ?? 0
    }
    const expect = (coll: string, field: string) =>
      plan.find((p) => p.coll === coll)!.docs.reduce((a, d) => a + d[field], 0)
    for (const [coll, field] of [['usageEvents', 'costMicros'], ['dailySnapshots', 'totalCostMicros']] as const) {
      const [got, want] = [await sum(coll, field), expect(coll, field)]
      if (got !== want) {
        ok = false
        console.error(`MISMATCH ${coll}.${field}: postgres ${want}, mongo ${got}`)
      }
    }
    console.log(ok ? 'verify: ok' : 'verify: FAILED')
    if (!ok) process.exitCode = 1
  } finally {
    await pool.end()
    await getClient().close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})
