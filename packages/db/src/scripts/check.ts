/**
 * Reports whether a database has the shape the code assumes, and exits 1 when
 * it does not. The same call /health makes, run by hand or by CI.
 *
 *   MONGODB_URI=mongodb://… npm run check -w @burn-watch/db
 */
import { strict as assert } from 'node:assert'
import { MongoClient } from 'mongodb'
import { assertSchemaCurrent } from '../schema.js'

async function main() {
  const uri = process.env.MONGODB_URI
  assert(uri, 'MONGODB_URI is required')

  const client = new MongoClient(uri)
  try {
    await assertSchemaCurrent(client.db())
    // Said out loud, and inside the try. Below the finally, a close() that
    // rejected on an otherwise-clean database would exit 1 over a teardown.
    console.log('clean: every collection, index and migration the code expects is present')
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  // exitCode, not exit(). Writes to a pipe are asynchronous on POSIX and
  // process.exit discards whatever is still queued; in CI stderr is always a
  // pipe, and the drift report is exactly the long payload that gets cut. A
  // checker that exits 1 having printed nothing is the one outcome it must
  // never produce. Both clients are closed in a finally, so nothing holds the
  // loop open and the process still ends here.
  process.exitCode = 1
})
