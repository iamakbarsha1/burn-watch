import { describe, it, expect } from 'vitest'
import type { UserId } from '@burn-watch/db'
import { freeTierRows, smallRowsByName } from './governance.js'

const row = (name: string, people: number) => ({ name, people })

describe('smallRowsByName', () => {
  it('keeps big rows in usage order and puts small rows last, by name', () => {
    const rows = [row('zeta', 9), row('solo', 1), row('alpha', 5), row('beta', 2), row('aaa', 4)]
    expect(smallRowsByName(rows, (r) => r.name).map((r) => r.name)).toEqual(['zeta', 'alpha', 'aaa', 'beta', 'solo'])
  })

  it('leaves the order alone when nothing is small', () => {
    const rows = [row('b', 3), row('a', 1)]
    expect(smallRowsByName(rows, (r) => r.name, 0)).toEqual(rows)
  })
})

describe('freeTierRows', () => {
  const group = (modelName: string, users: number, tokens: number) => ({
    _id: { agent: 'qwen' as const, modelName },
    users: Array.from({ length: users }, (_, i) => `${modelName}-${i}` as UserId),
    days: 3,
    tokens,
  })

  it('orders one-person models by name, not tokens, on Governance', () => {
    const rows = freeTierRows([group('z-big', 1, 900), group('a-small', 1, 100)]).rows
    expect(rows.map((r) => [r.modelName, r.tokens])).toEqual([
      ['a-small', null],
      ['z-big', null],
    ])
  })

  it('keeps token order and numbers for a person reading their own rows', () => {
    const rows = freeTierRows([group('z-big', 1, 900), group('a-small', 1, 100)], 0).rows
    expect(rows.map((r) => [r.modelName, r.tokens])).toEqual([
      ['z-big', 900],
      ['a-small', 100],
    ])
  })
})
