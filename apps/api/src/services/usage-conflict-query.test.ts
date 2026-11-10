import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/neon-serverless'
import type { UsageEvent } from '@burn-watch/shared'
import * as schema from '../../drizzle/schema.js'
import type { DbOrTx } from '../plugins/db.js'
import { upsertUsageEvents, type UsageSource } from './usage.service.js'

/**
 * `ON CONFLICT (cols)` has to name every column of the unique constraint or
 * postgres cannot work out which index to arbitrate on, and the insert raises
 * "no unique or exclusion constraint matching the ON CONFLICT specification"
 * instead of skipping the duplicate. Adding `source` to the constraint without
 * adding it here would turn every re-sync into a 500.
 *
 * The statement is rendered, never executed, the way `overview-query.test.ts`
 * does it. What is being checked is the rows and the conflict target the
 * service passes, which the type checker has nothing to say about.
 */
// Never connects.
const renderDb = drizzle({} as never, { schema })

const EVENT: UsageEvent = {
  agent: 'copilot',
  date: '2026-11-05',
  modelName: 'copilot',
  inputTokens: 1,
  outputTokens: 1,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 2,
  costUsd: 0.5,
  isFreeTier: false,
}

async function render(source?: UsageSource) {
  let sql = ''
  let rows: Record<string, unknown>[] = []
  let conflictOp = ''

  const db = {
    insert: (table: never) => ({
      values: (values: Record<string, unknown>[]) => {
        rows = values
        const build = (op: 'onConflictDoNothing' | 'onConflictDoUpdate') => (config: never) => {
          conflictOp = op
          const statement = renderDb.insert(table).values(values as never)
          sql = new PgDialect().sqlToQuery(
            (op === 'onConflictDoNothing'
              ? statement.onConflictDoNothing(config)
              : statement.onConflictDoUpdate(config)
            ).getSQL(),
          ).sql
          return { returning: async () => [] }
        }
        return {
          onConflictDoNothing: build('onConflictDoNothing'),
          onConflictDoUpdate: build('onConflictDoUpdate'),
        }
      },
    }),
  } as unknown as DbOrTx

  await upsertUsageEvents(db, 'user-1', 'device-1', '2026-11-05', [EVENT], source)
  return { sql, rows, conflictOp }
}

describe('the usage_events insert', () => {
  it('arbitrates on the full uniqueness key, source included', async () => {
    const { sql } = await render()
    expect(sql).toContain(
      'on conflict ("user_id","agent","date","model_name","device_id","source") do nothing',
    )
  })

  it('marks the device path agent-sourced without the caller saying so', async () => {
    const { rows } = await render()
    expect(rows[0]).toMatchObject({ source: 'agent', deviceId: 'device-1' })
  })

  it('carries a caller-named source through instead of overriding it', async () => {
    const { rows } = await render('copilot-org')
    expect(rows[0]).toMatchObject({ source: 'copilot-org' })
  })

  /**
   * The two sources want opposite things from a repeat, so the conflict action
   * is the thing that differs rather than the arbiter. A device resending a
   * day it already sent is reading the same local files twice. An org pull is
   * not: GitHub calls `ai_credits_used` a metrics signal rather than a billed
   * total, so a re-sync can legitimately carry corrected figures, and ignoring
   * it would leave a synced day permanently unrevisable.
   */
  it('ignores a repeat from a device, which has nothing new to say', async () => {
    const { conflictOp } = await render('agent')
    expect(conflictOp).toBe('onConflictDoNothing')
  })

  it('overwrites a repeat from the org pull, which may carry corrected figures', async () => {
    const { conflictOp, sql } = await render('copilot-org')
    expect(conflictOp).toBe('onConflictDoUpdate')
    expect(sql).toContain('"total_tokens" = excluded.total_tokens')
    expect(sql).toContain('"cost_usd" = excluded.cost_usd')
  })

  it('arbitrates the org path on the same full uniqueness key', async () => {
    const { sql } = await render('copilot-org')
    expect(sql).toContain(
      'on conflict ("user_id","agent","date","model_name","device_id","source") do update',
    )
  })
})
