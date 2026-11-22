import { describe, it, expect } from 'vitest'
import { PRICE_TABLE } from './prices.js'
import { PriceTableSchema } from './schemas.js'

describe('embedded price table', () => {
  it('names the pinned LiteLLM commit in its version', () => {
    expect(PRICE_TABLE.version).toMatch(/^\d{4}-\d{2}-\d{2}\+litellm\.[0-9a-f]{7}$/)
  })

  it('prices every Claude model seen in real transcripts, with the 5m/1h split', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']) {
      const p = PRICE_TABLE.models[m]
      expect(p, m).toBeDefined()
      expect(p.cacheWrite5m, m).toBeGreaterThan(0)
      expect(p.cacheWrite1h, m).toBeGreaterThan(p.cacheWrite5m!)
      expect(p.cacheRead, m).toBeGreaterThan(0)
    }
  })

  it('points every alias at a model in the table', () => {
    for (const [alias, target] of Object.entries(PRICE_TABLE.aliases)) {
      expect(PRICE_TABLE.models[target], alias).toBeDefined()
    }
  })

  it('rejects a zero price, so unknown is never stored as free', () => {
    const zero = { ...PRICE_TABLE, models: { m: { input: 0, output: 0.00001 } } }
    expect(PriceTableSchema.safeParse(zero).success).toBe(false)
  })
})
