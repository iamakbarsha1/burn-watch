import { describe, it, expect } from 'vitest'
import { usageEvents, claudeEnrichment, users } from '../../drizzle/schema.js'
import type { DB } from '../plugins/db.js'
import { rebuildDailySnapshot } from './snapshot.service.js'

type AgentRow = { agent: string; tokens: unknown; cost: unknown; models: string[] | null }

interface FakeTables {
  agentRows?: AgentRow[]
  enrichment?: { sessionCount: number; callCount: number; cacheHitRate: string | null } | null
  user?: { orgId: string } | null
}

/**
 * Stands in for the Drizzle query builder. Each chain method returns the same
 * thenable, so `.where().groupBy()` and `.where().limit(1)` both resolve to the
 * rows configured for whichever table `from()` was given.
 */
function fakeDb(tables: FakeTables) {
  const inserted: Record<string, unknown>[] = []

  const rowsFor = (table: unknown): unknown[] => {
    if (table === usageEvents) return tables.agentRows ?? []
    if (table === claudeEnrichment) return tables.enrichment ? [tables.enrichment] : []
    if (table === users) return tables.user ? [tables.user] : []
    throw new Error('fakeDb: unexpected table in select()')
  }

  const chain = (rows: unknown[]) => {
    const self: Record<string, unknown> = {
      where: () => self,
      groupBy: () => self,
      limit: () => self,
      then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(onOk, onErr),
    }
    return self
  }

  const db = {
    select: () => ({ from: (table: unknown) => chain(rowsFor(table)) }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row)
        return { onConflictDoUpdate: () => Promise.resolve() }
      },
    }),
  }

  return { db: db as unknown as DB, inserted }
}

const agentRow = (agent: string, tokens: unknown, cost: unknown, models: string[] = []) => ({
  agent,
  tokens,
  cost,
  models,
})

const DATE = '2026-11-05'
const USER = 'user-1'

describe('rebuildDailySnapshot', () => {
  it('fans each agent out onto its own pair of columns', async () => {
    const { db, inserted } = fakeDb({
      user: { orgId: 'org-1' },
      agentRows: [
        agentRow('claude', 44_000, 36.25, ['claude-opus-5']),
        agentRow('qwen', 280_000_000, 0, ['qwen3-coder-model']),
        agentRow('gemini', 800, 0.02, ['gemini-2.5-pro']),
        agentRow('codex', 130, 0.05, ['gpt-5-codex']),
        agentRow('copilot', 50, 0.01, ['copilot']),
      ],
    })

    await rebuildDailySnapshot(db, USER, DATE)

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      userId: USER,
      orgId: 'org-1',
      date: DATE,
      claudeTokens: 44_000,
      claudeCostUsd: '36.25',
      qwenTokens: 280_000_000,
      qwenCostUsd: '0',
      geminiTokens: 800,
      geminiCostUsd: '0.02',
      codexTokens: 130,
      codexCostUsd: '0.05',
      copilotTokens: 50,
      copilotCostUsd: '0.01',
    })
  })

  it('writes zeroes for agents with no events that day', async () => {
    const { db, inserted } = fakeDb({
      user: { orgId: 'org-1' },
      agentRows: [agentRow('claude', 100, 1.5)],
    })

    await rebuildDailySnapshot(db, USER, DATE)

    expect(inserted[0]).toMatchObject({
      qwenTokens: 0,
      qwenCostUsd: '0',
      geminiTokens: 0,
      geminiCostUsd: '0',
      codexTokens: 0,
      codexCostUsd: '0',
      copilotTokens: 0,
      copilotCostUsd: '0',
    })
  })

  it('sums tokens and cost across every agent', async () => {
    const { db, inserted } = fakeDb({
      user: { orgId: 'org-1' },
      agentRows: [
        agentRow('claude', 100, 1.5),
        agentRow('qwen', 200, 0),
        agentRow('gemini', 300, 2.25),
      ],
    })

    await rebuildDailySnapshot(db, USER, DATE)

    expect(inserted[0].totalTokens).toBe(600)
    expect(inserted[0].totalCostUsd).toBe('3.75')
  })

  it('adds numeric costs that arrive as strings instead of concatenating them', async () => {
    // A `sum()` over a `numeric` column is a string on the wire. If the
    // coercion is dropped, `'1.5' + '2.25'` yields '1.52.25' and the day's
    // total is wrong without anything throwing.
    const { db, inserted } = fakeDb({
      user: { orgId: 'org-1' },
      agentRows: [agentRow('claude', '100', '1.5'), agentRow('qwen', '200', '2.25')],
    })

    await rebuildDailySnapshot(db, USER, DATE)

    expect(inserted[0].totalTokens).toBe(300)
    expect(inserted[0].totalCostUsd).toBe('3.75')
    expect(inserted[0].claudeCostUsd).toBe('1.5')
  })

  it('treats an unparseable aggregate as zero rather than writing NaN', async () => {
    const { db, inserted } = fakeDb({
      user: { orgId: 'org-1' },
      agentRows: [agentRow('claude', null, undefined), agentRow('qwen', 'n/a', 'n/a')],
    })

    await rebuildDailySnapshot(db, USER, DATE)

    expect(inserted[0].totalTokens).toBe(0)
    expect(inserted[0].totalCostUsd).toBe('0')
    expect(String(inserted[0].claudeCostUsd)).not.toContain('NaN')
  })

  it('deduplicates models reported by more than one agent row', async () => {
    const { db, inserted } = fakeDb({
      user: { orgId: 'org-1' },
      agentRows: [
        agentRow('claude', 10, 1, ['claude-opus-5', 'claude-opus-5']),
        agentRow('codex', 10, 1, ['gpt-5-codex', 'claude-opus-5']),
      ],
    })

    await rebuildDailySnapshot(db, USER, DATE)

    expect(inserted[0].modelsUsed).toEqual(['claude-opus-5', 'gpt-5-codex'])
  })

  it('carries enrichment counts through when they exist', async () => {
    const { db, inserted } = fakeDb({
      user: { orgId: 'org-1' },
      agentRows: [agentRow('claude', 10, 1)],
      enrichment: { sessionCount: 4, callCount: 31, cacheHitRate: '92.10' },
    })

    await rebuildDailySnapshot(db, USER, DATE)

    expect(inserted[0]).toMatchObject({
      sessionCount: 4,
      callCount: 31,
      cacheHitRate: '92.10',
    })
  })

  it('defaults enrichment counts to zero and the hit rate to null when absent', async () => {
    const { db, inserted } = fakeDb({
      user: { orgId: 'org-1' },
      agentRows: [agentRow('qwen', 10, 0)],
      enrichment: null,
    })

    await rebuildDailySnapshot(db, USER, DATE)

    expect(inserted[0]).toMatchObject({ sessionCount: 0, callCount: 0, cacheHitRate: null })
  })

  it('writes nothing when the user does not exist', async () => {
    const { db, inserted } = fakeDb({
      user: null,
      agentRows: [agentRow('claude', 10, 1)],
    })

    await rebuildDailySnapshot(db, USER, DATE)

    expect(inserted).toHaveLength(0)
  })
})
