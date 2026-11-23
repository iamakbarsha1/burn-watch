import { describe, it, expect } from 'vitest'
import type { PriceTable } from '@burn-watch/shared'
import { UsageCollector } from './usage.js'
import type { AgentParser, UsageRecord } from './parsers/types.js'

const table: PriceTable = {
  version: '2026-11-22+litellm.aaaaaaa',
  source: 'test',
  models: { m: { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 } },
  aliases: {},
}

const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  agent: 'claude',
  model: 'm',
  at: '2026-11-20T12:00:00.000Z',
  input: 1,
  output: 2,
  cacheWrite5m: 3,
  cacheWrite1h: 4,
  cacheRead: 5,
  key: 'k1',
  ...over,
})

const fake = (agent: AgentParser['agent'], records: UsageRecord[]): AgentParser => ({
  agent,
  roots: () => [process.cwd()],
  async *read() {
    yield* records
  },
})

describe('UsageCollector', () => {
  it('groups by UTC date, agent and model, and dedupes on key', async () => {
    const c = new UsageCollector(
      [
        fake('claude', [
          rec({ key: 'a' }),
          rec({ key: 'a' }), // copy of a streamed reply
          rec({ key: 'b', at: '2026-11-20T23:59:59.999Z' }),
          rec({ key: 'c', at: '2026-11-21T00:00:00.000Z' }),
          rec({ key: 'd', model: 'other' }),
          rec({ key: 'e', at: '2026-11-19T12:00:00.000Z' }), // outside the range
        ]),
      ],
      table,
    )
    const out = await c.collectRange(['2026-11-20', '2026-11-21'])
    const day = out.get('2026-11-20')!
    expect(day).toHaveLength(2)
    expect(day[0]).toEqual({
      agent: 'claude',
      date: '2026-11-20',
      modelName: 'm',
      inputTokens: 2,
      outputTokens: 4,
      cacheCreateTokens: 14,
      cacheReadTokens: 10,
      totalTokens: 30,
      costUsd: 30,
      isFreeTier: false,
    })
    expect(out.get('2026-11-21')![0].totalTokens).toBe(15)
    expect(out.has('2026-11-19')).toBe(false)
  })

  it('marks an unknown model unpriced, not free, and reports its tokens', async () => {
    const c = new UsageCollector([fake('claude', [rec({ model: 'other' })])], table)
    const [e] = (await c.collectRange(['2026-11-20'])).get('2026-11-20')!
    expect(e).toMatchObject({ costUsd: 0, isFreeTier: false, unpriced: true })
    expect(c.summary.unpriced).toEqual({ other: 15 })
  })

  it('sets isFreeTier only from FREE_TIER_AGENTS, at zero cost', async () => {
    const c = new UsageCollector([fake('qwen', [rec({ agent: 'qwen', model: 'qwen3-coder' })])], table)
    const [e] = (await c.collectRange(['2026-11-20'])).get('2026-11-20')!
    expect(e).toMatchObject({ isFreeTier: true, costUsd: 0 })
    expect(e.unpriced).toBeUndefined()
  })

  it('keeps the same key apart across agents', async () => {
    const c = new UsageCollector(
      [fake('claude', [rec({ key: 'x' })]), fake('codex', [rec({ agent: 'codex', key: 'x' })])],
      table,
    )
    expect((await c.collectRange(['2026-11-20'])).get('2026-11-20')).toHaveLength(2)
  })

  it('buckets by the given day function, reading files from the day before', async () => {
    let since = ''
    const parser: AgentParser = {
      ...fake('claude', [rec({ at: '2026-11-19T20:00:00.000Z' })]),
      async *read(_roots, s) {
        since = s
        yield rec({ at: '2026-11-19T20:00:00.000Z' })
      },
    }
    // IST: 20:00 UTC on the 19th is 01:30 on the 20th.
    const ist = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(0, 10)
    const out = await new UsageCollector([parser], table, ist).collectRange(['2026-11-20'])
    expect(out.get('2026-11-20')).toHaveLength(1)
    expect(since).toBe('2026-11-19')
  })

  it('is unavailable when no parser has a root on disk', async () => {
    const none: AgentParser = { ...fake('claude', []), roots: () => ['/no/such/dir'] }
    expect(await new UsageCollector([none], table).isAvailable()).toBe(false)
  })
})
