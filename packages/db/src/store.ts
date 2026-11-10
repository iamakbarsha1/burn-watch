import {
  MongoClient,
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
import { COLLECTIONS, type CollectionSpec } from './registry.js'

/** The ten driver calls the apps use, with the session already applied. */
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

type DocOf<S> = S extends CollectionSpec<infer T> ? T : never

/**
 * Derived from COLLECTIONS, never written out. A hand-spelled member list and
 * the registry are two places that have to agree about a collection name, and
 * the one that drifts is the one nothing checks.
 */
export type Store = {
  readonly [K in keyof typeof COLLECTIONS]: Bound<DocOf<(typeof COLLECTIONS)[K]>>
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
  const out: Record<string, Bound<Document>> = {}
  for (const name of Object.keys(COLLECTIONS)) out[name] = bound(db.collection(name), session)
  // The loop binds every member the same way, so the per-member document type
  // is the registry's claim rather than something the compiler can follow here.
  return out as unknown as Store
}

const backing = new WeakMap<Store, { client: MongoClient; db: Db }>()

/**
 * A Store over an explicit client. Scripts that need several independent
 * connections use this.
 *
 * It bypasses getDb(), so a caller holding one of these is on its own handle
 * and gets none of the bootstrap or health guarantees that getStore()-rooted
 * callers share. That is the point for the race script, which wants separate
 * connections, and a trap for anything else.
 */
export function storeFor(client: MongoClient, dbName?: string): Store {
  const db = client.db(dbName)
  const store = bindAll(db)
  backing.set(store, { client, db })
  return store
}

let client: MongoClient | undefined
let db: Db | undefined
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

/**
 * The Db every Store binds and every check interrogates. One handle, no second
 * opinion: a health check that reads a different database than the Store
 * writes to proves nothing about the one serving traffic.
 */
export function getDb(): Db {
  return (db ??= getClient().db())
}

export function getStore(): Store {
  if (!store) {
    const handle = getDb()
    store = bindAll(handle)
    backing.set(store, { client: getClient(), db: handle })
  }
  return store
}

const TXN: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
}

/**
 * Runs fn in one multi-document transaction, readConcern 'snapshot', writeConcern 'majority'.
 *
 * fn MAY RUN MORE THAN ONCE. The driver's withTransaction re-runs it whenever an
 * operation inside aborts with a TransientTransactionError, which is what a
 * WriteConflict on a document another transaction touched raises. Every body we
 * pass is upserts plus a full recompute, so a re-run converges.
 *
 * A DuplicateKey (11000) is not retried. src/scripts/snapshot-race.ts showed
 * every concurrent collision, on the snapshot _id and on the usageEvents unique
 * index, on one node and on three, surfaces as WriteConflict. Inside a
 * transaction 11000 means the duplicate already existed at the snapshot, which a
 * retry would only repeat.
 */
export async function runInTxn<T>(store: Store, fn: (tx: Txn) => Promise<T>): Promise<T> {
  const b = backing.get(store)
  if (!b) throw new Error('runInTxn needs a Store from getStore() or storeFor(), not a Txn')
  const session = b.client.startSession()
  try {
    let out!: T
    await session.withTransaction(async () => {
      out = await fn(bindAll(b.db, session) as Txn)
    }, TXN)
    return out
  } finally {
    await session.endSession()
  }
}
