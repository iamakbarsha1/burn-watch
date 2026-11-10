import type { Document } from 'mongodb'
import type { Store, Txn } from '@burn-watch/db'

/**
 * The route tests' stand-in for a Store.
 *
 * Reads answer from documents a test seeded against the collection name and
 * ignore the filter entirely, which is the same bargain the Drizzle fake it
 * replaces struck: a fake that tried to honour filters would be a second,
 * unverified MongoDB, and the one query it got subtly wrong is the one nothing
 * would ever catch. Filters are asserted against `calls` instead, where they
 * are read rather than re-implemented.
 *
 * Seeding by collection rather than queueing answers in order is the one real
 * change. The Drizzle fake handed back a positional queue, so every test had
 * to know how many statements the services under it would issue and in what
 * sequence, and inserting a read anywhere shifted every comment one line down.
 */
export interface MongoFakeState {
  /** What a find or findOne on that collection answers with. */
  docs: Record<string, Document[]>
  /** What an aggregate on that collection answers with. */
  aggregates: Record<string, Document[]>
  /** Every operation in the order it was issued. */
  calls: { op: string; collection: string; args: unknown[] }[]
  /** `collection.op` to throw on, for the cases about a transaction rolling back. */
  failOn: string | null
  /** What bulkWrite reports, which is what decides accepted against skipped. */
  bulk: { upsertedCount: number; matchedCount: number }
}

/**
 * `collections` is passed in rather than read off the registry here, because
 * the one caller builds this inside a `vi.mock` factory for the very package
 * the registry lives in. Importing a value from it there is a cycle vitest
 * resolves by deadlocking, with no error and no failing test.
 */
export function fakeStore(state: MongoFakeState, collections: string[]): Store {
  const members: Record<string, unknown> = {}

  for (const collection of collections) {
    const record = (op: string, args: unknown[]) => {
      state.calls.push({ op, collection, args })
      if (state.failOn === `${collection}.${op}`) {
        throw new Error(`fake mongo: ${collection}.${op} failed`)
      }
    }
    const seeded = () => state.docs[collection] ?? []

    members[collection] = {
      findOne: async (...args: unknown[]) => (record('findOne', args), seeded()[0] ?? null),
      find: async (...args: unknown[]) => (record('find', args), seeded()),
      aggregate: async (...args: unknown[]) =>
        (record('aggregate', args), state.aggregates[collection] ?? []),
      insertOne: async (...args: unknown[]) => record('insertOne', args),
      updateOne: async (...args: unknown[]) => (record('updateOne', args), { matchedCount: 1 }),
      updateMany: async (...args: unknown[]) => (record('updateMany', args), { matchedCount: 1 }),
      findOneAndUpdate: async (...args: unknown[]) =>
        (record('findOneAndUpdate', args), seeded()[0] ?? null),
      bulkWrite: async (...args: unknown[]) => (record('bulkWrite', args), state.bulk),
      // A seeded document means the row was there to delete, which is what every
      // 404-or-204 case turns on.
      deleteOne: async (...args: unknown[]) => (record('deleteOne', args), seeded().length > 0 ? 1 : 0),
      deleteMany: async (...args: unknown[]) => (record('deleteMany', args), seeded().length),
    }
  }

  return members as unknown as Store
}

/**
 * Stands in for runInTxn. The body runs against the same store, with the open
 * and any rollback recorded, so a test can assert that a write landed inside
 * the transaction rather than beside it.
 *
 * It never re-runs the body. The real one may, on a write conflict, and nothing
 * in a single-threaded test can produce one.
 */
export function fakeRunInTxn(state: MongoFakeState, store: Store) {
  return async <T>(_store: Store, fn: (tx: Txn) => Promise<T>): Promise<T> => {
    state.calls.push({ op: 'transaction', collection: '', args: [] })
    try {
      return await fn(store as Txn)
    } catch (error) {
      state.calls.push({ op: 'rollback', collection: '', args: [] })
      throw error
    }
  }
}

/** The arguments of every call to one collection's operation, in order. */
export const callsTo = (state: MongoFakeState, collection: string, op: string): unknown[][] =>
  state.calls.filter((c) => c.collection === collection && c.op === op).map((c) => c.args)
