import type { Db } from 'mongodb'

/**
 * Sortable and unique. The numeric prefix is what orders the array, and the
 * type rejects an id that has none.
 *
 * Not nominally branded. A `unique symbol` brand makes the type reject the
 * very literals it exists to accept, and the optional-property form that does
 * accept them admits any `${number}_${string}` anyway, so it buys nothing the
 * template literal does not already give.
 */
export type MigrationId = `${number}_${string}`

export interface Migration {
  /** Also the _id of its bookkeeping document. */
  readonly id: MigrationId
  readonly description: string
  /**
   * Idempotent and convergent. May run more than once, and may run against a
   * database where a previous attempt died partway.
   *
   * Takes a Db, not a Txn, on purpose. A backfill outlives the 60-second
   * transaction limit and the 16MB oplog entry, so the body batches and owns
   * its own restartability. Nothing here needs the BW-41 guarantee, because
   * migrations run out of band rather than alongside live writes.
   */
  run(db: Db): Promise<void>
}

export interface MigrationDoc {
  _id: MigrationId
  startedAt: Date
  completedAt: Date | null
  host: string
}

/**
 * Not a registry entry and not a CollectionSpec. The first claim's insertOne
 * creates it, a plain find reads it, and an absent collection simply has no
 * rows. Listing it in COLLECTIONS would make it a thirteenth thing to create
 * and a thirteenth thing whose absence reads as drift, when its absence only
 * means no migration has ever been claimed.
 */
export const MIGRATIONS_COLLECTION = '_migrations'

/**
 * Applied in array order, each one once, recorded in _migrations.
 *
 * There is no `down`. A Mongo data migration's inverse is almost never the
 * same code path, and an untested one is a lie that makes a rollback feel
 * safe. The upgrade path is a new forward migration.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_noop_marker',
    // Exists only so the claim protocol and its bookkeeping are exercised end
    // to end before Phase 3 needs a real backfill. A mechanism whose first run
    // is the run that matters has never been run.
    description: 'no-op marker, proves runMigrations claims and records',
    async run() {},
  },
]
