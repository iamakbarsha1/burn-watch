import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PriceTable } from '@burn-watch/shared'
import { PRICE_TABLE } from '@burn-watch/shared/prices'
import { loadPriceTable, lookupPrice, priceRecord, refreshPrices } from './pricing.js'
import type { UsageRecord } from './parsers/types.js'

const table: PriceTable = {
  version: '2026-11-22+litellm.aaaaaaa',
  source: 'test',
  models: {
    plain: { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 0.5 },
    tiered: { input: 1, output: 2, cacheRead: 0.5, above200k: { input: 10, output: 20, cacheRead: 5 } },
  },
  aliases: { 'plain-20260101': 'plain' },
}

const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  agent: 'claude',
  model: 'plain',
  at: '2026-11-20T00:00:00.000Z',
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  key: 'k',
  ...over,
})

describe('priceRecord', () => {
  it('prices each token kind', () => {
    expect(priceRecord(table, rec({ input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 2 }))).toBe(
      1 + 2 + 3 + 4 + 1,
    )
  })

  it('looks up aliases', () => {
    expect(lookupPrice(table, 'plain-20260101')).toBe(table.models.plain)
  })

  it('returns null for an unknown model, so it is unpriced and not free', () => {
    expect(priceRecord(table, rec({ model: 'nope', input: 5 }))).toBeNull()
  })

  it('moves the whole request to the 200k tier, counting cache tokens, per request', () => {
    // 200,000 exactly stays on the base tier.
    expect(priceRecord(table, rec({ model: 'tiered', input: 100_000, cacheRead: 100_000 }))).toBe(150_000)
    // One more token and every token is at the higher price.
    expect(priceRecord(table, rec({ model: 'tiered', input: 100_001, cacheRead: 100_000 }))).toBe(
      100_001 * 10 + 100_000 * 5,
    )
  })

  it('prices a 1h write at the 5m price when the model has no 1h price', () => {
    const t = { ...table, models: { m: { input: 1, output: 1, cacheWrite5m: 3 } } }
    expect(priceRecord(t, rec({ model: 'm', cacheWrite1h: 2 }))).toBe(6)
  })

  it('reproduces the embedded Opus 5.5 list price', () => {
    const cost = priceRecord(
      PRICE_TABLE,
      rec({ model: 'claude-opus-5-5', input: 1e6, output: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6 }),
    )
    expect(cost).toBeCloseTo(4 + 20 + 5 + 8 + 0.2, 9)
  })
})

describe('price table cache', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bw-prices-'))
    file = join(dir, 'prices.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('uses a cached table newer than the embedded one', () => {
    writeFileSync(file, JSON.stringify({ ...table, version: '2099-01-01+litellm.bbbbbbb' }))
    expect(loadPriceTable(file, table).version).toBe('2099-01-01+litellm.bbbbbbb')
  })

  it('keeps the embedded table over an older or broken cache', () => {
    writeFileSync(file, JSON.stringify({ ...table, version: '2000-01-01+litellm.ccccccc' }))
    expect(loadPriceTable(file, table)).toBe(table)
    writeFileSync(file, '{broken')
    expect(loadPriceTable(file, table)).toBe(table)
  })

  it('writes a fetched table, sending the current version as If-None-Match', async () => {
    let sent: string | undefined
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent = (init.headers as Record<string, string>)['If-None-Match']
      return new Response(JSON.stringify({ ...PRICE_TABLE, version: '2099-01-01+litellm.ddddddd' }))
    })
    expect(await refreshPrices('https://api.test', file, fetchFn)).toBe('updated')
    expect(sent).toBe(`"${PRICE_TABLE.version}"`)
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe('2099-01-01+litellm.ddddddd')
  })

  it('does not fetch again within a day', async () => {
    writeFileSync(file, JSON.stringify(PRICE_TABLE))
    const fetchFn = (async () => {
      throw new Error('should not fetch')
    })
    expect(await refreshPrices('https://api.test', file, fetchFn)).toBe('fresh')
  })

  it('touches the cache on 304 so the next fetch waits a day', async () => {
    writeFileSync(file, JSON.stringify(PRICE_TABLE))
    const old = new Date('2026-01-01T00:00:00Z')
    utimesSync(file, old, old)
    const now = Date.parse('2026-11-23T00:00:00Z')
    const fetchFn = (async () => new Response(null, { status: 304 }))
    expect(await refreshPrices('https://api.test', file, fetchFn, now)).toBe('unchanged')
    expect(statSync(file).mtimeMs).toBe(now)
  })

  it('keeps what it has when the fetch fails', async () => {
    const fetchFn = (async () => {
      throw new Error('offline')
    })
    expect(await refreshPrices('https://api.test', file, fetchFn)).toBe('failed')
    expect(existsSync(file)).toBe(false)
    expect(loadPriceTable(file)).toBe(PRICE_TABLE)
  })

  it('rejects a fetched table that fails the schema', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ version: 'x' })))
    expect(await refreshPrices('https://api.test', file, fetchFn)).toBe('failed')
    expect(existsSync(file)).toBe(false)
  })
})
