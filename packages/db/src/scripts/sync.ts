/**
 * Brings a database up to the registry. The operator's explicit action, never
 * a build step and never part of serving a request.
 *
 *   MONGODB_URI=mongodb://… npm run sync -w @burn-watch/db
 */
import { strict as assert } from 'node:assert'
import { MongoClient } from 'mongodb'
import { syncSchema } from '../schema.js'

async function main() {
  const uri = process.env.MONGODB_URI
  assert(uri, 'MONGODB_URI is required')

  const client = new MongoClient(uri)
  try {
    const report = await syncSchema(client.db())
    const list = (items: readonly string[]) => (items.length > 0 ? items.join(', ') : 'none')
    // Ensured, not created. Both calls are idempotent and neither reports
    // which of these it built and which were already there. `check` before a
    // sync is what names what was actually missing.
    console.log(`collections ensured: ${list(report.ensuredCollections)}`)
    console.log(`migrations run: ${list(report.ranMigrations)}`)
    console.log(`migrations already recorded: ${list(report.skippedMigrations)}`)
    console.log(`indexes ensured: ${list(report.ensuredIndexes)}`)
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  // The stack, not just the message. An IndexKeySpecsConflict out of the
  // createIndexes loop names the conflict but not which iteration raised it.
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  // exitCode rather than exit(1): process.exit drops queued writes to a pipe,
  // and in CI stderr is a pipe. See check.ts for the longer note.
  process.exitCode = 1
})
