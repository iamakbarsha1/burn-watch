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
  } finally {
    await client.close()
  }
  // Said out loud. Silence from a checker reads as a crash.
  console.log('clean: every collection, index and migration the code expects is present')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
