import { describe, expect, it } from 'vitest'
import type { Document, IndexDescriptionInfo } from 'mongodb'
import { COLLECTIONS, type CollectionSpec, type IndexSpec } from './registry.js'
import { MIGRATIONS } from './migrations.js'
import { diffStructure, isClean, type Observed } from './schema.js'

const SPECS: [string, CollectionSpec<Document>][] = Object.entries(COLLECTIONS)

/** What listIndexes would report for an index that matches its spec. */
const asLive = (i: IndexSpec<Document>): IndexDescriptionInfo => ({
  name: i.name,
  key: i.key as IndexDescriptionInfo['key'],
  ...(i.unique ? { unique: true } : {}),
  ...(i.expireAfterSeconds === undefined ? {} : { expireAfterSeconds: i.expireAfterSeconds }),
  v: 2,
})

interface Mutable {
  collections: Set<string>
  indexes: Map<string, IndexDescriptionInfo[]>
  completedMigrations: Set<string>
  claimedMigrations: Set<string>
}

/** A database that matches the registry exactly. Each test deviates by one thing. */
function current(): Mutable {
  return {
    collections: new Set(SPECS.map(([name]) => name)),
    indexes: new Map(SPECS.map(([name, spec]) => [name, spec.indexes.map(asLive)])),
    completedMigrations: new Set(MIGRATIONS.map((m) => m.id)),
    claimedMigrations: new Set(MIGRATIONS.map((m) => m.id)),
  }
}

/** Replaces one live index, or drops it when change returns null. */
function reshape(
  o: Mutable,
  collection: string,
  name: string,
  change: (i: IndexDescriptionInfo) => IndexDescriptionInfo | null,
): void {
  const list = o.indexes.get(collection) ?? []
  o.indexes.set(
    collection,
    list.flatMap((i) => {
      if (i.name !== name) return [i]
      const next = change(i)
      return next ? [next] : []
    }),
  )
}

const observed = (o: Mutable): Observed => o

describe('diffStructure', () => {
  // Without this the fixture could be wrong in a way that makes every "detects
  // X" case below pass for the wrong reason.
  it('reports nothing against a database that matches the registry', () => {
    const drift = diffStructure(observed(current()))
    expect(drift).toEqual({
      missingCollections: [],
      missingIndexes: [],
      conflictingIndexes: [],
      pendingMigrations: [],
      inFlightMigrations: [],
    })
    expect(isClean(drift)).toBe(true)
  })

  it('names a collection the server does not have', () => {
    const o = current()
    o.collections.delete('claudeEnrichment')
    o.indexes.delete('claudeEnrichment')

    const drift = diffStructure(observed(o))
    expect(drift.missingCollections).toEqual(['claudeEnrichment'])
    // Named once. A collection that does not exist has no separate index
    // problem, and listing both would bury the one fix.
    expect(drift.missingIndexes).toEqual([])
  })

  it('names an index the server does not have', () => {
    const o = current()
    reshape(o, 'usageEvents', 'usageEvents_key', () => null)

    const drift = diffStructure(observed(o))
    expect(drift.missingIndexes).toEqual([{ collection: 'usageEvents', index: 'usageEvents_key' }])
    expect(drift.conflictingIndexes).toEqual([])
  })

  /**
   * The silent one. {userId:1,date:1} and {date:1,userId:1} answer different
   * queries, and MongoDB will not hold both under one name, so an index whose
   * fields come back in another order is a hand edit nobody recorded.
   */
  it('treats a reordered compound key as a conflict, not a match', () => {
    const o = current()
    reshape(o, 'usageEvents', 'usageEvents_key', (i) => ({
      ...i,
      key: Object.fromEntries(Object.entries(i.key).reverse()),
    }))

    const drift = diffStructure(observed(o))
    expect(drift.missingIndexes).toEqual([])
    expect(drift.conflictingIndexes).toHaveLength(1)
    const [c] = drift.conflictingIndexes
    expect(c.collection).toBe('usageEvents')
    expect(c.index).toBe('usageEvents_key')
    expect(c.expected).toMatch(/^\{userId:1,date:1,/)
    expect(c.live).toMatch(/^\{source:1,deviceId:1,/)
  })

  /**
   * The index that matters most. Lose uniqueness on usageEvents_key and the
   * two-tier upsert stops deduplicating without failing anything, so every
   * re-sync quietly inserts a duplicate.
   */
  it('catches an index that exists but is no longer unique', () => {
    const o = current()
    reshape(o, 'usageEvents', 'usageEvents_key', ({ unique: _unique, ...rest }) => rest)

    const drift = diffStructure(observed(o))
    expect(drift.conflictingIndexes).toHaveLength(1)
    expect(drift.conflictingIndexes[0].expected).toContain('unique')
    expect(drift.conflictingIndexes[0].live).not.toContain('unique')
  })

  it('catches a TTL index set to the wrong expiry', () => {
    const o = current()
    reshape(o, 'rateLimits', 'rateLimits_ttl', (i) => ({ ...i, expireAfterSeconds: 3600 }))

    const drift = diffStructure(observed(o))
    expect(drift.conflictingIndexes).toHaveLength(1)
    expect(drift.conflictingIndexes[0].expected).toContain('ttl=0')
    expect(drift.conflictingIndexes[0].live).toContain('ttl=3600')
  })

  it('catches a TTL index that came back with no expiry at all', () => {
    const o = current()
    reshape(o, 'rateLimits', 'rateLimits_ttl', ({ expireAfterSeconds: _ttl, ...rest }) => rest)

    const drift = diffStructure(observed(o))
    expect(drift.conflictingIndexes).toHaveLength(1)
    expect(drift.conflictingIndexes[0].live).not.toContain('ttl')
  })

  it('names a migration the database has never recorded', () => {
    const o = current()
    o.completedMigrations.clear()
    o.claimedMigrations.clear()

    const drift = diffStructure(observed(o))
    expect(drift.pendingMigrations).toEqual(MIGRATIONS.map((m) => m.id))
    expect(drift.inFlightMigrations).toEqual([])
  })

  /**
   * A claim with no completedAt is a run that died partway. Recording it as
   * done would be BW-37's shape rebuilt, so it fails the check instead.
   */
  it('names a migration claimed and never completed', () => {
    const o = current()
    o.completedMigrations.clear()

    const drift = diffStructure(observed(o))
    expect(drift.inFlightMigrations).toEqual(MIGRATIONS.map((m) => m.id))
    expect(isClean(drift)).toBe(false)
  })

  describe('a database ahead of the code is a rollback, not an outage', () => {
    it('ignores a collection the registry does not declare', () => {
      const o = current()
      o.collections.add('experimentalThing')
      o.indexes.set('experimentalThing', [asLive({ name: 'whatever', key: { a: 1 } })])

      expect(isClean(diffStructure(observed(o)))).toBe(true)
    })

    it('ignores an extra index on a collection it does declare', () => {
      const o = current()
      o.indexes.set('usageEvents', [
        ...(o.indexes.get('usageEvents') ?? []),
        asLive({ name: 'usageEvents_from_a_later_deploy', key: { costMicros: -1 } }),
      ])

      expect(isClean(diffStructure(observed(o)))).toBe(true)
    })

    it('ignores a migration id this deploy does not carry', () => {
      const o = current()
      o.completedMigrations.add('0099_from_a_later_deploy')
      o.claimedMigrations.add('0099_from_a_later_deploy')

      const drift = diffStructure(observed(o))
      expect(drift.pendingMigrations).toEqual([])
      expect(drift.inFlightMigrations).toEqual([])
      expect(isClean(drift)).toBe(true)
    })
  })
})
