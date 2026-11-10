import { hostname } from 'node:os'
import {
  MongoServerError,
  type Db,
  type Document,
  type IndexDescription,
  type IndexDescriptionInfo,
} from 'mongodb'
import { COLLECTIONS, type CollectionSpec, type IndexSpec } from './registry.js'
import {
  MIGRATIONS,
  MIGRATIONS_COLLECTION,
  type Migration,
  type MigrationDoc,
} from './migrations.js'
import { getDb } from './store.js'

/** The registry as a list, widened once so every consumer shares one element type. */
const SPECS: readonly (readonly [name: string, spec: CollectionSpec<Document>])[] =
  Object.entries(COLLECTIONS)

/** What the server actually has. Everything the check decides is decided from this. */
export interface Observed {
  readonly collections: ReadonlySet<string>
  /** Live indexes by collection name. An absent entry reads the same as none. */
  readonly indexes: ReadonlyMap<string, readonly IndexDescriptionInfo[]>
  /** Migration ids whose bookkeeping document records a completedAt. */
  readonly completedMigrations: ReadonlySet<string>
  /** Every migration id with a bookkeeping document, completed or not. */
  readonly claimedMigrations: ReadonlySet<string>
}

export interface SchemaDrift {
  readonly missingCollections: readonly string[]
  readonly missingIndexes: readonly { collection: string; index: string }[]
  readonly conflictingIndexes: readonly {
    collection: string
    index: string
    expected: string
    live: string
  }[]
  readonly pendingMigrations: readonly string[]
  readonly inFlightMigrations: readonly string[]
}

export const isClean = (d: SchemaDrift): boolean =>
  d.missingCollections.length +
    d.missingIndexes.length +
    d.conflictingIndexes.length +
    d.pendingMigrations.length +
    d.inFlightMigrations.length ===
  0

/**
 * Everything compared about an index, rendered once. The comparison is string
 * equality over this, so what an operator reads is exactly what disagreed.
 */
const describeIndex = (
  key: Readonly<Record<string, unknown>>,
  opts: {
    unique?: boolean
    expireAfterSeconds?: number
    sparse?: boolean
    hidden?: boolean
    partialFilterExpression?: Readonly<Record<string, unknown>>
    collation?: { locale?: string; strength?: number }
  },
): string => {
  // Field order is part of the index. {userId:1,date:1} and {date:1,userId:1}
  // serve different queries, and MongoDB refuses to hold both under one name,
  // so a difference here means a hand edit or a migration nobody wrote down.
  const fields = Object.entries(key)
    .map(([field, direction]) => `${field}:${String(direction)}`)
    .join(',')
  // unique and ttl are not the whole story. A partialFilterExpression, sparse,
  // hidden or a collation each change which documents an index covers while
  // leaving the key pattern untouched, so comparing keys and uniqueness alone
  // renders two different indexes as the same string. The case that matters:
  // usageEvents_key carrying partialFilterExpression {source:'agent'} is still
  // unique over the same six fields, so this read clean while every
  // copilot-org row fell outside the filter and re-synced as a duplicate —
  // the exact silent failure the live check exists to catch.
  //
  // No false positives. listIndexes omits all four unless they were specified,
  // and IndexSpec cannot express any of them, so the registry's intent is
  // always "none of these" and any live value is real drift.
  const flags = [
    opts.unique ? 'unique' : '',
    opts.sparse ? 'sparse' : '',
    opts.hidden ? 'hidden' : '',
    opts.expireAfterSeconds === undefined ? '' : `ttl=${opts.expireAfterSeconds}`,
    opts.partialFilterExpression ? `partial=${JSON.stringify(opts.partialFilterExpression)}` : '',
    opts.collation ? `collation=${opts.collation.locale}/${opts.collation.strength}` : '',
  ].filter(Boolean)
  return flags.length > 0 ? `{${fields}} ${flags.join(' ')}` : `{${fields}}`
}

/**
 * Pure. Given what the server has, says how it differs from the registry.
 *
 * One-directional on purpose. Extra collections, extra indexes and extra
 * recorded migration ids are never reported, because a database ahead of the
 * code is a rollback rather than an outage. That is the same rule the Postgres
 * check holds when the recorded version is higher than the expected one.
 */
export function diffStructure(observed: Observed): SchemaDrift {
  const missingCollections: string[] = []
  const missingIndexes: { collection: string; index: string }[] = []
  const conflictingIndexes: SchemaDrift['conflictingIndexes'][number][] = []

  for (const [collection, spec] of SPECS) {
    if (!observed.collections.has(collection)) {
      // Its indexes are not listed too. A collection that does not exist has no
      // separate index problem, and naming both would bury the one fix.
      missingCollections.push(collection)
      continue
    }
    const live = new Map((observed.indexes.get(collection) ?? []).map((i) => [i.name, i]))
    for (const want of spec.indexes) {
      const got = live.get(want.name)
      if (!got) {
        missingIndexes.push({ collection, index: want.name })
        continue
      }
      const expected = describeIndex(want.key, want)
      const actual = describeIndex(got.key, got)
      if (expected !== actual) {
        conflictingIndexes.push({ collection, index: want.name, expected, live: actual })
      }
    }
  }

  return {
    missingCollections,
    missingIndexes,
    conflictingIndexes,
    // Never claimed, not merely not completed. A claim with no completedAt is
    // reported as in-flight below, and the two headings call for opposite
    // responses: run sync, versus investigate before touching anything.
    // Filtering on completion alone printed one id under both at once.
    pendingMigrations: MIGRATIONS.filter((m) => !observed.claimedMigrations.has(m.id)).map(
      (m) => m.id,
    ),
    // A claim with no completedAt is a run that died partway, which is a
    // half-applied schema whatever the code expects, so one recorded by a
    // version this deploy does not carry still counts.
    inFlightMigrations: [...observed.claimedMigrations].filter(
      (id) => !observed.completedMigrations.has(id),
    ),
  }
}

/** The I/O half. Reads live server state every call, caching nothing. */
export async function observe(db: Db): Promise<Observed> {
  const collections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  )

  // listIndexes against an absent namespace throws, and a missing collection is
  // already reported, so only present ones are read. One round trip each.
  const present = SPECS.filter(
    ([name, spec]) => collections.has(name) && spec.indexes.length > 0,
  ).map(([name]) => name)
  const lists = await Promise.all(present.map((name) => db.collection(name).listIndexes().toArray()))

  // No guard on whether _migrations exists. find() against an absent
  // collection resolves with no rows, verified against mongod 8.0, and no rows
  // is exactly what "nothing has ever been claimed" means. That is what keeps
  // the collection out of the registry: nobody has to remember to create it.
  const claimed = await db.collection<MigrationDoc>(MIGRATIONS_COLLECTION).find({}).toArray()

  return {
    collections,
    indexes: new Map(present.map((name, i) => [name, lists[i]])),
    completedMigrations: new Set(claimed.filter((m) => m.completedAt).map((m) => m._id)),
    claimedMigrations: new Set(claimed.map((m) => m._id)),
  }
}

/**
 * Round-trips to the server. Separate from the schema check so a dead
 * connection and a stale schema page differently.
 *
 * `async` is load-bearing, not style. The `db = getDb()` default calls
 * getClient(), which throws when MONGODB_URI is unset. In an async function a
 * default initializer that throws rejects the returned promise, so
 * Promise.allSettled in /health records it and the route answers 503 naming
 * this dependency. Rewritten as a plain function returning a promise, the same
 * throw escapes before allSettled is reached and /health 500s instead, naming
 * nothing.
 */
export async function pingDb(db: Db = getDb()): Promise<void> {
  await db.command({ ping: 1 })
}

/**
 * Rejects when the deployed database does not have the shape the deployed code
 * assumes.
 *
 * BW-37 is why this exists, and MongoDB makes its lesson sharper. In Postgres a
 * missing column fails a query. Here a missing usageEvents_key unique index
 * fails nothing at all. The two-tier upsert simply stops deduplicating and
 * every re-sync inserts a duplicate, silently, forever.
 *
 * So this reads live state every call. listCollections, listIndexes and a real
 * query against the bookkeeping collection, with no cache and no recorded
 * fingerprint. A fingerprint says something once ran a sync. It cannot say an
 * index was dropped by hand, lost to a restored backup, or never finished
 * building, and those are the states worth catching.
 *
 * `async` is load-bearing for the same reason it is on pingDb. The default
 * argument throws when MONGODB_URI is unset, and only an async function turns
 * that into the rejection /health needs.
 */
export async function assertSchemaCurrent(db: Db = getDb()): Promise<void> {
  const drift = diffStructure(await observe(db))
  if (isClean(drift)) return
  // Operator-facing. build-server.ts logs it and answers 503 with the
  // dependency name only, so this text never reaches a response body.
  throw new Error(summarise(drift))
}

function summarise(d: SchemaDrift): string {
  const lines: string[] = []
  if (d.missingCollections.length > 0) {
    lines.push(`missing collections: ${d.missingCollections.join(', ')}`)
  }
  if (d.missingIndexes.length > 0) {
    lines.push(`missing indexes: ${d.missingIndexes.map((i) => `${i.collection}.${i.index}`).join(', ')}`)
  }
  for (const c of d.conflictingIndexes) {
    lines.push(`conflicting index ${c.collection}.${c.index}: expected ${c.expected}, live ${c.live}`)
  }
  if (d.pendingMigrations.length > 0) {
    lines.push(`pending migrations: ${d.pendingMigrations.join(', ')}`)
  }
  if (d.inFlightMigrations.length > 0) {
    lines.push(`claimed and never completed: ${d.inFlightMigrations.join(', ')}`)
  }
  return `MongoDB schema drift. Run \`npm run sync -w @burn-watch/db\`.\n  ${lines.join('\n  ')}`
}

export interface SyncReport {
  /**
   * Every registry collection this run asked the server for, created or
   * already there. MongoDB 8 answers a repeat `create` with ok rather than
   * NamespaceExists, so sync cannot tell the two apart without a round trip
   * whose answer `check` already gives.
   */
  readonly ensuredCollections: readonly string[]
  readonly ranMigrations: readonly string[]
  readonly skippedMigrations: readonly string[]
  /** `collection.index` for every index handed to createIndexes, built or already there. */
  readonly ensuredIndexes: readonly string[]
}

/**
 * Brings a database up to the registry. An operator runs this out of band, via
 * scripts/sync.ts.
 *
 * Never wired into Fastify boot, never a build step, never in vercel.json. The
 * API is a Vercel function with no durable startup, so boot-time DDL would run
 * on the request path at every cold start and would hand the serving role
 * rights it should not have. A build step is worse: previews and production
 * build from the same repo, which is the reason migrate-on-deploy was rejected
 * for Postgres and nothing about MongoDB changes it.
 *
 * Additive. Nothing is ever dropped, because a rollback deploy running an older
 * sync would otherwise drop an index the running code still needs. Dropping is
 * an explicit migration with an id.
 */
export async function syncSchema(db: Db): Promise<SyncReport> {
  // Collections first, before anything transactional can reach one. An implicit
  // create inside a transaction surfaces its write conflict at COMMIT, where
  // the body cannot see it. Every registry entry is created, not only the ones
  // with writers today, so a collection added this deploy cannot be born inside
  // the first transaction that touches it. Going first also means a later step
  // throwing still leaves that race closed.
  const ensuredCollections: string[] = []
  for (const [name] of SPECS) {
    await ensureCollection(db, name)
    ensuredCollections.push(name)
  }

  // Then migrations, and only then indexes. A unique index over a field that a
  // backfill populates must not be built before the backfill, or it collides on
  // the rows the migration has not reached yet.
  const ranMigrations: string[] = []
  const skippedMigrations: string[] = []
  for (const m of MIGRATIONS) {
    if (await runOnce(db, m)) ranMigrations.push(m.id)
    else skippedMigrations.push(m.id)
  }

  // createIndexes is idempotent for an identical name and key, so this reports
  // what it ensured rather than claiming it created anything. A matching name
  // over a different key raises IndexKeySpecsConflict and is not swallowed:
  // that is real divergence and an operator has to resolve it.
  const ensuredIndexes: string[] = []
  for (const [name, spec] of SPECS) {
    if (spec.indexes.length === 0) continue
    await db.collection(name).createIndexes(spec.indexes.map(toDescription))
    ensuredIndexes.push(...spec.indexes.map((i) => `${name}.${i.name}`))
  }

  return { ensuredCollections, ranMigrations, skippedMigrations, ensuredIndexes }
}

const toDescription = (i: IndexSpec<Document>): IndexDescription => ({
  name: i.name,
  key: i.key as IndexDescription['key'],
  ...(i.unique ? { unique: true } : {}),
  ...(i.expireAfterSeconds === undefined ? {} : { expireAfterSeconds: i.expireAfterSeconds }),
})

/**
 * NamespaceExists is tolerated rather than relied on. MongoDB 8 answers a
 * repeat create with ok, but an older server and a second operator syncing at
 * the same moment both still raise it.
 */
async function ensureCollection(db: Db, name: string): Promise<void> {
  await db.createCollection(name).catch((err: unknown) => {
    if (!(err instanceof MongoServerError && err.codeName === 'NamespaceExists')) throw err
  })
}

/** True when this call ran it, false when it was already recorded as done. */
async function runOnce(db: Db, m: Migration): Promise<boolean> {
  const coll = db.collection<MigrationDoc>(MIGRATIONS_COLLECTION)
  // The claim is the lock. A second runner's insert collides on _id, so two
  // operators cannot run one backfill at once.
  // ponytail: no lease expiry, a crashed run is cleared by hand after checking
  // nothing is live. Add a heartbeat only if unattended runners ever appear.
  const claimed = await coll
    .insertOne({ _id: m.id, startedAt: new Date(), completedAt: null, host: hostname() })
    .then(
      () => true,
      (err: unknown) => {
        if (err instanceof MongoServerError && err.code === 11000) return false
        throw err
      },
    )

  if (!claimed) {
    const held = await coll.findOne({ _id: m.id })
    if (held?.completedAt) return false
    throw new Error(
      `${m.id} was claimed at ${held?.startedAt?.toISOString()} by ${held?.host} and never completed. ` +
        'Confirm nothing is still running it, then delete that _migrations document and re-run.',
    )
  }

  await m.run(db)
  await coll.updateOne({ _id: m.id }, { $set: { completedAt: new Date() } })
  return true
}
