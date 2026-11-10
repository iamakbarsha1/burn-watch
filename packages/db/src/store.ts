import {
  MongoClient,
  MongoServerError,
  type AnyBulkWriteOperation,
  type BulkWriteResult,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type Filter,
  type OptionalUnlessRequiredId,
  type Sort,
  type TransactionOptions,
  type UpdateFilter,
  type UpdateResult,
} from 'mongodb'
import type { DailySnapshotDoc, UsageEventDoc, UserDoc } from './documents.js'

/** The nine driver calls the apps use, with the session already applied. */
export interface Bound<T extends Document> {
  findOne(filter: Filter<T>, opts?: { projection?: Document; sort?: Sort }): Promise<T | null>
  find(filter: Filter<T>, opts?: { projection?: Document; sort?: Sort; limit?: number }): Promise<T[]>
  aggregate<R extends Document = Document>(pipeline: Document[]): Promise<R[]>
  insertOne(doc: OptionalUnlessRequiredId<T>): Promise<void>
  updateOne(
    filter: Filter<T>,
    update: UpdateFilter<T> | Document[],
    opts?: { upsert?: boolean },
  ): Promise<UpdateResult<T>>
  updateMany(filter: Filter<T>, update: UpdateFilter<T>): Promise<UpdateResult<T>>
  findOneAndUpdate(
    filter: Filter<T>,
    update: UpdateFilter<T> | Document[],
    opts?: { upsert?: boolean },
  ): Promise<T | null>
  bulkWrite(ops: AnyBulkWriteOperation<T>[]): Promise<BulkWriteResult>
  deleteOne(filter: Filter<T>): Promise<number>
  deleteMany(filter: Filter<T>): Promise<number>
}

export interface Store {
  readonly users: Bound<UserDoc>
  readonly usageEvents: Bound<UsageEventDoc>
  readonly dailySnapshots: Bound<DailySnapshotDoc>
}

declare const inTxn: unique symbol
/** A Store whose every operation runs inside one transaction. Only runInTxn makes one. */
export type Txn = Store & { readonly [inTxn]: true }

function bound<T extends Document>(coll: Collection<T>, session?: ClientSession): Bound<T> {
  // Spread last so a caller's opts can never drop the session.
  const s = session ? { session } : {}
  return {
    findOne: (filter, opts) => coll.findOne(filter, { ...opts, ...s }) as Promise<T | null>,
    find: (filter, opts) => coll.find(filter, { ...opts, ...s }).toArray() as Promise<T[]>,
    aggregate: <R extends Document>(pipeline: Document[]) => coll.aggregate<R>(pipeline, s).toArray(),
    insertOne: async (doc) => {
      await coll.insertOne(doc, s)
    },
    updateOne: (filter, update, opts) => coll.updateOne(filter, update, { ...opts, ...s }),
    updateMany: (filter, update) => coll.updateMany(filter, update, s),
    findOneAndUpdate: (filter, update, opts) =>
      coll.findOneAndUpdate(filter, update, { ...opts, returnDocument: 'after', ...s }) as Promise<T | null>,
    bulkWrite: (ops) => coll.bulkWrite(ops, s),
    deleteOne: async (filter) => (await coll.deleteOne(filter, s)).deletedCount,
    deleteMany: async (filter) => (await coll.deleteMany(filter, s)).deletedCount,
  }
}

function bindAll(db: Db, session?: ClientSession): Store {
  return {
    users: bound(db.collection<UserDoc>('users'), session),
    usageEvents: bound(db.collection<UsageEventDoc>('usageEvents'), session),
    dailySnapshots: bound(db.collection<DailySnapshotDoc>('dailySnapshots'), session),
  }
}

const backing = new WeakMap<Store, { client: MongoClient; db: Db }>()

/** A Store over an explicit client. Scripts that need several independent connections use this. */
export function storeFor(client: MongoClient, dbName?: string): Store {
  const db = client.db(dbName)
  const store = bindAll(db)
  backing.set(store, { client, db })
  return store
}

let client: MongoClient | undefined
let store: Store | undefined

/** One MongoClient per process, lazily built so importing needs no MONGODB_URI. */
export function getClient(): MongoClient {
  if (!client) {
    const uri = process.env.MONGODB_URI
    if (!uri) throw new Error('MONGODB_URI is not set')
    client = new MongoClient(uri, { maxPoolSize: 10 })
  }
  return client
}

export function getStore(): Store {
  return (store ??= storeFor(getClient()))
}

const TXN: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
}

const DUPLICATE_KEY = 11000
const DUPLICATE_KEY_ATTEMPTS = 3

export const isDuplicateKey = (err: unknown): boolean =>
  err instanceof MongoServerError && err.code === DUPLICATE_KEY

/**
 * Runs fn in one multi-document transaction, readConcern 'snapshot', writeConcern 'majority'.
 *
 * fn MAY RUN MORE THAN ONCE. The driver's withTransaction re-runs it whenever an
 * operation inside aborts with a TransientTransactionError, which is what a
 * WriteConflict on a document another transaction touched raises. Every body we
 * pass is upserts plus a full recompute, so a re-run converges.
 *
 * A DuplicateKey (11000) is treated the same way, up to three attempts. An upsert
 * whose insert path lost to a commit newer than our snapshot is expected to
 * surface as WriteConflict; if a server reports it as 11000 instead, this keeps
 * the same guarantee. A genuine duplicate still fails, three times slower.
 * scripts/snapshot-race.ts records which of the two actually occurs.
 */
export async function runInTxn<T>(store: Store, fn: (tx: Txn) => Promise<T>): Promise<T> {
  const b = backing.get(store)
  if (!b) throw new Error('runInTxn needs a Store from getStore() or storeFor(), not a Txn')
  const session = b.client.startSession()
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        let out!: T
        await session.withTransaction(async () => {
          out = await fn(bindAll(b.db, session) as Txn)
        }, TXN)
        return out
      } catch (err) {
        if (isDuplicateKey(err) && attempt < DUPLICATE_KEY_ATTEMPTS) continue
        throw err
      }
    }
  } finally {
    await session.endSession()
  }
}
