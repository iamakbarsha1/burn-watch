import { describe, expect, it } from 'vitest'
import type { Db, Document } from 'mongodb'
import { MIGRATIONS } from './migrations.js'

describe('0005_drop_leaderboard_settings', () => {
  /** updateMany honouring only `{ field: { $exists: true } }` with `$unset`, the one shape 0005 sends. */
  function fakeDb(collections: Record<string, Document[]>) {
    const modified: Record<string, number> = {}
    const db = {
      collection: (name: string) => ({
        updateMany: async (filter: Document, update: { $unset: Record<string, ''> }) => {
          const [field, cond] = Object.entries(filter)[0] ?? []
          if (Object.keys(filter).length !== 1 || JSON.stringify(cond) !== '{"$exists":true}') {
            throw new Error(`unsupported filter: ${JSON.stringify(filter)}`)
          }
          let n = 0
          for (const doc of collections[name] ?? []) {
            if (!(field in doc)) continue
            for (const key of Object.keys(update.$unset)) delete doc[key]
            n++
          }
          modified[name] = (modified[name] ?? 0) + n
          return { matchedCount: n, modifiedCount: n }
        },
      }),
    } as unknown as Db
    return { db, modified }
  }

  it('unsets leaderboard on organizations and hideOnLeaderboard on users, and a re-run is a no-op', async () => {
    const migration = MIGRATIONS.find((m) => m.id === '0005_drop_leaderboard_settings')!
    const organizations: Document[] = [
      { _id: 'o1', name: 'Acme', leaderboard: { developerView: 'full', showNames: false, showOthersCost: true } },
      { _id: 'o2', name: 'Beta' },
    ]
    const users: Document[] = [
      { _id: 'u1', name: 'Ada', hideOnLeaderboard: true },
      { _id: 'u2', name: 'Bo', hideOnLeaderboard: false },
      { _id: 'u3', name: 'Cy' },
    ]
    const { db, modified } = fakeDb({ organizations, users })
    await migration.run(db)
    expect(organizations).toEqual([
      { _id: 'o1', name: 'Acme' },
      { _id: 'o2', name: 'Beta' },
    ])
    expect(users).toEqual([
      { _id: 'u1', name: 'Ada' },
      { _id: 'u2', name: 'Bo' },
      { _id: 'u3', name: 'Cy' },
    ])
    expect(modified).toEqual({ organizations: 1, users: 2 })

    const once = structuredClone({ organizations, users })
    await migration.run(db)
    expect({ organizations, users }).toEqual(once)
    expect(modified).toEqual({ organizations: 1, users: 2 })
  })
})

describe('0006_drop_per_person_alerts', () => {
  it('deletes only alerts set on one person, and a re-run is a no-op', async () => {
    const migration = MIGRATIONS.find((m) => m.id === '0006_drop_per_person_alerts')!
    let alerts: Document[] = [
      { _id: 'a1', orgId: 'o1', userId: null, agent: null },
      { _id: 'a2', orgId: 'o1', userId: 'u1', agent: 'claude' },
      { _id: 'a3', orgId: 'o2', userId: null, agent: 'codex' },
      { _id: 'a4', orgId: 'o2', userId: 'u2', agent: null },
    ]
    const calls: [string, Document][] = []
    const db = {
      collection: (name: string) => ({
        // Honours only `{ userId: { $ne: null } }`, the one shape 0006 sends.
        deleteMany: async (filter: Document) => {
          calls.push([name, filter])
          if (JSON.stringify(filter) !== '{"userId":{"$ne":null}}') throw new Error(`unsupported filter: ${JSON.stringify(filter)}`)
          const before = alerts.length
          alerts = alerts.filter((a) => a.userId === null)
          return { deletedCount: before - alerts.length }
        },
      }),
    } as unknown as Db

    await migration.run(db)
    expect(calls).toEqual([['budgetAlerts', { userId: { $ne: null } }]])
    expect(alerts.map((a) => a._id)).toEqual(['a1', 'a3'])

    await migration.run(db)
    expect(alerts.map((a) => a._id)).toEqual(['a1', 'a3'])
  })
})
