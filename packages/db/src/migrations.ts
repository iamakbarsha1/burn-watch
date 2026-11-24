import type { AnyBulkWriteOperation, Db, Document } from 'mongodb'
import { commandNames, repoName } from './usage.js'

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
  {
    id: '0002_budget_alert_type',
    description: 'budget alerts get type api-spend, idleDays null, limitHits null',
    // Matching only alerts without `type` is what makes a re-run a no-op.
    async run(db) {
      await db
        .collection('budgetAlerts')
        .updateMany({ type: { $exists: false } }, { $set: { type: 'api-spend', idleDays: null, limitHits: null } })
    },
  },
  {
    id: '0003_project_path_basename',
    description: 'claudeEnrichment project paths cut to the repo name; home folders become ~',
    // In node rather than a pipeline so it shares repoName with the write path.
    // Only documents still holding a separator match, so a re-run is a no-op.
    // submittedAt in the filter: a day re-synced mid-run keeps its newer breakdown.
    async run(db) {
      const coll = db.collection('claudeEnrichment')
      const cursor = coll.find(
        { 'projectBreakdown.path': { $regex: '[/\\\\]' } },
        { projection: { projectBreakdown: 1, submittedAt: 1 } },
      )
      let ops: AnyBulkWriteOperation[] = []
      for await (const doc of cursor) {
        const projectBreakdown = (doc.projectBreakdown as Document[]).map((p) => ({ ...p, path: repoName(p.path) }))
        ops.push({ updateOne: { filter: { _id: doc._id, submittedAt: doc.submittedAt }, update: { $set: { projectBreakdown } } } })
        if (ops.length === 500) {
          await coll.bulkWrite(ops)
          ops = []
        }
      }
      if (ops.length > 0) await coll.bulkWrite(ops)
    },
  },
  {
    id: '0004_shell_usage_basename',
    description: 'claudeEnrichment shellUsage keys cut to the command name, counts summed on collision',
    // Same shape as 0003, sharing commandNames with the write path.
    // Only documents with a key still holding a separator match, so a re-run is a no-op.
    // submittedAt in the filter: a day re-synced mid-run keeps its newer counts.
    async run(db) {
      const coll = db.collection('claudeEnrichment')
      const cursor = coll.find(
        {
          $expr: {
            $anyElementTrue: {
              $map: {
                input: { $objectToArray: { $ifNull: ['$shellUsage', {}] } },
                in: { $regexMatch: { input: '$$this.k', regex: '[/\\\\]' } },
              },
            },
          },
        },
        { projection: { shellUsage: 1, submittedAt: 1 } },
      )
      let ops: AnyBulkWriteOperation[] = []
      for await (const doc of cursor) {
        const shellUsage = commandNames(doc.shellUsage as Record<string, number>)
        ops.push({ updateOne: { filter: { _id: doc._id, submittedAt: doc.submittedAt }, update: { $set: { shellUsage } } } })
        if (ops.length === 500) {
          await coll.bulkWrite(ops)
          ops = []
        }
      }
      if (ops.length > 0) await coll.bulkWrite(ops)
    },
  },
  {
    id: '0005_drop_leaderboard_settings',
    description: 'v2: unset leaderboard on organizations and hideOnLeaderboard on users',
    // The leaderboard is gone; nothing reads either field. Matching on $exists makes a re-run a no-op.
    async run(db) {
      await db.collection('organizations').updateMany({ leaderboard: { $exists: true } }, { $unset: { leaderboard: '' } })
      await db.collection('users').updateMany({ hideOnLeaderboard: { $exists: true } }, { $unset: { hideOnLeaderboard: '' } })
    },
  },
]
