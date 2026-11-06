import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXPECTED_SCHEMA_VERSION, assertSchemaCurrent } from './schema-version.js'
import type { DbOrTx } from './plugins/db.js'

const journal = JSON.parse(
  readFileSync(join(import.meta.dirname, '../drizzle/migrations/meta/_journal.json'), 'utf8'),
) as { entries: { when: number; tag: string }[] }

const newest = journal.entries.reduce((a, b) => (b.when > a.when ? b : a))

function fakeDb(result: unknown): DbOrTx {
  return { execute: async () => result } as unknown as DbOrTx
}

describe('EXPECTED_SCHEMA_VERSION', () => {
  /**
   * The constant and the journal have to agree, and nothing but this test
   * makes them. Generate a migration without updating the constant and the
   * health check would keep reporting a stale schema as current — which is
   * the exact blindness BW-37 is about, reintroduced one level up.
   */
  it('matches the newest entry in the migration journal', () => {
    expect(EXPECTED_SCHEMA_VERSION).toBe(newest.when)
  })

  it('is the maximum, not merely the last line of the file', () => {
    expect(EXPECTED_SCHEMA_VERSION).toBe(Math.max(...journal.entries.map((e) => e.when)))
  })
})

describe('assertSchemaCurrent', () => {
  it('passes when the database records the version the code expects', async () => {
    await expect(
      assertSchemaCurrent(fakeDb([{ latest: EXPECTED_SCHEMA_VERSION }])),
    ).resolves.toBeUndefined()
  })

  it('passes when the database is ahead, which is a rollback not an outage', async () => {
    await expect(
      assertSchemaCurrent(fakeDb([{ latest: EXPECTED_SCHEMA_VERSION + 1 }])),
    ).resolves.toBeUndefined()
  })

  // The BW-37 case exactly: 0004 generated, committed, never applied.
  it('rejects when the database is behind the code', async () => {
    await expect(
      assertSchemaCurrent(fakeDb([{ latest: EXPECTED_SCHEMA_VERSION - 1 }])),
    ).rejects.toThrow(/behind/)
  })

  it('rejects a database that has never been migrated at all', async () => {
    await expect(assertSchemaCurrent(fakeDb([{ latest: 0 }]))).rejects.toThrow(/behind/)
  })

  it('reads a driver QueryResult as readily as a plain array', async () => {
    await expect(
      assertSchemaCurrent(fakeDb({ rows: [{ latest: EXPECTED_SCHEMA_VERSION }] })),
    ).resolves.toBeUndefined()
  })

  it('treats an unreadable answer as behind rather than as healthy', async () => {
    await expect(assertSchemaCurrent(fakeDb([]))).rejects.toThrow(/behind/)
    await expect(assertSchemaCurrent(fakeDb([{ latest: 'nonsense' }]))).rejects.toThrow(/behind/)
  })
})
