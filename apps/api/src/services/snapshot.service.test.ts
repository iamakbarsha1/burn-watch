import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/neon-serverless'
import * as schema from '../../drizzle/schema.js'
import { usageEvents, claudeEnrichment, users } from '../../drizzle/schema.js'
import type { DB } from '../plugins/db.js'
import { agentTotalsQuery, rebuildDailySnapshot } from './snapshot.service.js'

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
    if (table === claudeEnrichment) return tables.enrichment ? [tables.enrichment] : []
    if (table === users) return tables.user ? [tables.user] : []
    // Anything else is the per-agent aggregate, which reads usage_events
    // through a subquery object rather than the table itself. The subquery is
    // built by the same `select()` this fake is standing in for, so matching it
    // by identity is not possible here.
    return tables.agentRows ?? []
  }

  // A `.as()` subquery, whose columns the outer select and filter reach for by
  // name. Every property answers with a distinct object so none of drizzle's
  // expression builders is handed `undefined`.
  const subquery = new Proxy({} as Record<string, unknown>, {
    get: (store, key: string) => (store[key] ??= {}),
  })

  const chain = (rows: unknown[]) => {
    const self: Record<string, unknown> = {
      where: () => self,
      groupBy: () => self,
      limit: () => self,
      as: () => subquery,
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

/**
 * The source preference lives in SQL, so these render the statement the
 * service actually builds and read it, the way `overview-query.test.ts` does.
 * The fake above cannot reach it: it answers with rows postgres would already
 * have resolved.
 */
// Never connects. The statement is built and rendered, never executed.
const rendered = new PgDialect().sqlToQuery(
  agentTotalsQuery(drizzle({} as never, { schema }), USER, DATE).getSQL(),
)

describe('the per-agent source resolution', () => {
  it('aggregates tokens, cost and models per agent', () => {
    expect(rendered.sql).toMatch(/sum\("total_tokens"\)/i)
    expect(rendered.sql).toMatch(/sum\("cost_usd"\)/i)
    expect(rendered.sql).toMatch(/array_agg\(distinct "model_name"\)/i)
    expect(rendered.sql).toMatch(/group by "scoped"\."agent"/i)
  })

  it('keeps a row whose source is the agent', () => {
    expect(rendered.sql).toMatch(/where \("scoped"\."source" = \$\d/i)
    // The literal is bound, so the SQL text alone cannot say which source wins.
    expect(rendered.params).toContain('agent')
    expect(rendered.params).not.toContain('copilot-org')
  })

  it('keeps the other source only when that agent has no agent-sourced row', () => {
    expect(rendered.sql).toMatch(/or not "agent_sourced"\)/i)
  })

  it('decides per agent rather than once for the whole day', () => {
    // A developer with agent-sourced claude and org-sourced copilot on one day
    // has to get both. An unpartitioned `over ()` would see the claude row and
    // drop the copilot one.
    expect(rendered.sql).toMatch(/bool_or\("source" = 'agent'\) over \(partition by "agent"\)/i)
    expect(rendered.sql).not.toMatch(/over \(\s*\)/i)
  })

  it('resolves in one round trip rather than reading rows into js', () => {
    expect(rendered.sql.match(/from "usage_events"/gi)).toHaveLength(1)
    expect(rendered.sql).not.toContain(';')
  })
})

const migration = readFileSync(
  join(import.meta.dirname, '../../drizzle/migrations/0005_usage_event_source.sql'),
  'utf8',
)

/**
 * An org-sourced row has no device, so `device_id` is null on all of them.
 * Under postgres' default NULLS DISTINCT the unique constraint would never see
 * two such rows as equal, `onConflictDoNothing` would find nothing to skip, and
 * every re-pull would add another copy of the same day.
 *
 * Asserted against the DDL rather than against a live database: the migration
 * is applied by hand here, and there is no postgres 15-or-newer instance in
 * this checkout to run it against. The behaviour these guard is postgres', so
 * what is checkable from here is that the constraint carries the clause that
 * selects it and names every column of the key.
 */
describe('the usage_events uniqueness key', () => {
  const unique = getTableConfig(usageEvents).uniqueConstraints

  it('treats two null device_ids as the same row', () => {
    expect(unique).toHaveLength(1)
    expect(unique[0].nullsNotDistinct).toBe(true)
    expect(migration).toMatch(/UNIQUE NULLS NOT DISTINCT/)
  })

  it('separates the two sources instead of collapsing them', () => {
    expect(unique[0].columns.map((c) => c.name)).toEqual([
      'user_id',
      'agent',
      'date',
      'model_name',
      'device_id',
      'source',
    ])
    expect(migration).toContain(
      '"usage_events_unique_user_agent_date_model_device_source" UNIQUE NULLS NOT DISTINCT' +
        '("user_id","agent","date","model_name","device_id","source")',
    )
  })

  it('drops the device-only constraint that would have rejected the org row', () => {
    // Left in place it still forbids a second row per (user, agent, day,
    // model, device), which is exactly the org row for a developer ccusage
    // already reported.
    expect(migration).toContain(
      'DROP CONSTRAINT "usage_events_unique_user_agent_date_model_device"',
    )
    expect(migration).toContain('ALTER COLUMN "device_id" DROP NOT NULL')
  })
})
