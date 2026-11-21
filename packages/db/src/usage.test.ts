import { describe, expect, it } from 'vitest'
import type { Db, Document } from 'mongodb'
import type { ClaudeEnrichment } from '@burn-watch/shared'
import type { IsoDate, OrgId, UserId } from './ids.js'
import { MIGRATIONS } from './migrations.js'
import type { Txn } from './store.js'
import { repoName, upsertEnrichment } from './usage.js'

describe('repoName', () => {
  it.each([
    ['/a/b/repo', 'repo'],
    ['C:\\a\\repo', 'repo'],
    ['/a/b/repo/', 'repo'],
    ['repo', 'repo'],
    ['/Users/someone', '~'],
    ['/home/someone/', '~'],
    ['C:\\Users\\someone', '~'],
    ['/Users/someone/code', 'code'],
  ])('%s gives %s', (path, expected) => {
    expect(repoName(path)).toBe(expected)
  })
})

describe('upsertEnrichment', () => {
  const base: ClaudeEnrichment = {
    date: '2026-11-05',
    sessionCount: 1,
    callCount: 1,
    cacheHitRate: 0,
    writtenTokens: 0,
    activityBreakdown: [],
    projectBreakdown: [
      { path: '/a/b/repo', cost: 1, avgPerSession: 1, sessions: 1, overheadK: 0 },
      { path: 'C:\\a\\other', cost: 1, avgPerSession: 1, sessions: 1, overheadK: 0 },
    ],
    topSessions: [],
    toolUsage: {},
    shellUsage: { git: 2, '/opt/tools/bin/git': 1, './run.sh': 1 },
    mcpUsage: {},
  }

  async function write(enrichment: ClaudeEnrichment) {
    const sets: Document[] = []
    const tx = {
      claudeEnrichment: { updateOne: async (_f: unknown, u: Document) => void sets.push(u.$set) },
      dailySnapshots: { updateOne: async () => undefined },
    } as unknown as Txn
    await upsertEnrichment(tx, 'u' as UserId, 'o' as OrgId, '2026-11-05' as IsoDate, enrichment)
    return sets[0]
  }

  it('strips a 0.3 agent path to its last segment and stores null for absent 0.4 fields', async () => {
    const set = await write(base)
    expect(set.projectBreakdown.map((p: Document) => [p.path, p.remote])).toEqual([
      ['repo', null],
      ['other', null],
    ])
    expect(set.shellUsage).toEqual({ git: 3, 'run.sh': 1 })
    for (const field of ['claudeVersions', 'entrypointCounts', 'skillCounts', 'sidechainMessages', 'permissionModeCounts', 'accountHashes', 'claudeOrgHashes']) {
      expect(set[field], field).toBeNull()
    }
  })

  it('stores the 0.4 fields as sent', async () => {
    const set = await write({
      ...base,
      projectBreakdown: [{ path: 'repo', remote: 'github.com/org/repo', branches: [{ name: 'main', cost: 1, sessions: 1 }], cost: 1, avgPerSession: 1, sessions: 1, overheadK: 0 }],
      claudeVersions: { '2.1.0': 2 },
      sidechainMessages: 0,
      accountHashes: ['a'.repeat(64)],
    })
    expect(set.projectBreakdown[0]).toMatchObject({ path: 'repo', remote: 'github.com/org/repo', branches: [{ name: 'main' }] })
    expect(set.claudeVersions).toEqual({ '2.1.0': 2 })
    expect(set.sidechainMessages).toBe(0)
    expect(set.accountHashes).toEqual(['a'.repeat(64)])
  })
})

describe('0003_project_path_basename', () => {
  /** find with the separator regex, bulkWrite of updateOne $set by _id and submittedAt. */
  function fakeDb(docs: Document[]): Db {
    const coll = {
      find: (filter: Document) => {
        const re = new RegExp(filter['projectBreakdown.path'].$regex)
        return docs.filter((d) => (d.projectBreakdown ?? []).some((p: Document) => re.test(p.path)))
      },
      bulkWrite: async (ops: Document[]) => {
        for (const { updateOne } of ops) {
          const doc = docs.find((d) => d._id === updateOne.filter._id && d.submittedAt === updateOne.filter.submittedAt)
          if (doc) Object.assign(doc, updateOne.update.$set)
        }
      },
    }
    return { collection: () => coll } as unknown as Db
  }

  it('cuts paths to the repo name, home folders to ~, and is idempotent', async () => {
    const migration = MIGRATIONS.find((m) => m.id === '0003_project_path_basename')!
    const p = (path: string) => ({ path, cost: 1, sessions: 1, avgPerSession: 1, overheadK: 0 })
    const docs: Document[] = [
      { _id: 'old', submittedAt: 1, projectBreakdown: [p('/Users/someone/code/repo'), p('/Users/someone'), p('C:\\x\\y')] },
      { _id: 'new', submittedAt: 2, projectBreakdown: [p('repo')] },
      { _id: 'none', submittedAt: 3, projectBreakdown: null },
    ]
    const db = fakeDb(docs)
    await migration.run(db)
    const once = structuredClone(docs)
    await migration.run(db)
    expect(docs).toEqual(once)
    expect(docs.map((d) => d.projectBreakdown?.map((x: Document) => x.path) ?? null)).toEqual([
      ['repo', '~', 'y'],
      ['repo'],
      null,
    ])
    expect(docs[0].projectBreakdown[0]).toEqual(p('repo'))
  })
})

describe('0004_shell_usage_basename', () => {
  /** find mimics the $expr key-separator match, bulkWrite of updateOne $set by _id and submittedAt. */
  function fakeDb(docs: Document[]): Db {
    const coll = {
      find: () => docs.filter((d) => Object.keys(d.shellUsage ?? {}).some((k) => /[/\\]/.test(k))),
      bulkWrite: async (ops: Document[]) => {
        for (const { updateOne } of ops) {
          const doc = docs.find((d) => d._id === updateOne.filter._id && d.submittedAt === updateOne.filter.submittedAt)
          if (doc) Object.assign(doc, updateOne.update.$set)
        }
      },
    }
    return { collection: () => coll } as unknown as Db
  }
  const migration = MIGRATIONS.find((m) => m.id === '0004_shell_usage_basename')!

  it('folds path keys to the command name, sums collisions, leaves the rest, and is idempotent', async () => {
    const docs: Document[] = [
      { _id: 'old', submittedAt: 1, shellUsage: { '/usr/bin/git': 3, git: 5, '/usr/local/bin/foo': 2, '/Users/someone/bin/x': 1, ls: 4 } },
      { _id: 'plain', submittedAt: 2, shellUsage: { git: 6, npm: 1 } },
      { _id: 'none', submittedAt: 3, shellUsage: null },
    ]
    const db = fakeDb(docs)
    await migration.run(db)
    const once = structuredClone(docs)
    await migration.run(db)
    expect(docs).toEqual(once)
    expect(docs.map((d) => d.shellUsage)).toEqual([{ git: 8, foo: 2, x: 1, ls: 4 }, { git: 6, npm: 1 }, null])
  })

  it('skips a day re-synced after the read', async () => {
    const docs: Document[] = [{ _id: 'raced', submittedAt: 1, shellUsage: { '/usr/bin/git': 3 } }]
    const db = fakeDb(docs)
    const coll = db.collection('claudeEnrichment') as unknown as { find: () => Document[] }
    const find = coll.find
    coll.find = () => {
      const hit = find()
      // A sync lands between the read and the write.
      docs[0] = { _id: 'raced', submittedAt: 2, shellUsage: { git: 9 } }
      return hit.map((d) => ({ ...d }))
    }
    await migration.run(db)
    expect(docs[0]).toEqual({ _id: 'raced', submittedAt: 2, shellUsage: { git: 9 } })
  })
})
