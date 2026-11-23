import { describe, it, expect } from 'vitest'
import type { PracticeGroup } from '@burn-watch/shared'
import { MIN_QUARTILE_PEOPLE, median, practiceGroup, practiceTips, quartileSplit, type PracticePerson } from './quartile.js'

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, rank: n - i, tokens: 0 }))
const ids = (xs: { userId: string }[]) => xs.map((x) => x.userId)

describe('quartileSplit', () => {
  it('refuses below the minimum and splits from it', () => {
    expect(MIN_QUARTILE_PEOPLE).toBe(4)
    expect(quartileSplit(people(3))).toBeNull()
    expect(ids(quartileSplit(people(4))!.top)).toEqual(['u0'])
    expect(quartileSplit(people(4))!.rest).toHaveLength(3)
    expect(ids(quartileSplit(people(8))!.top)).toEqual(['u0', 'u1'])
    expect(quartileSplit(people(8))!.rest).toHaveLength(6)
    expect(ids(quartileSplit(people(9))!.top)).toEqual(['u0', 'u1', 'u2'])
  })

  it('breaks a tie at the cut by tokens, then userId, whatever the input order', () => {
    const tied = [
      { userId: 'c', rank: 5, tokens: 10 },
      { userId: 'b', rank: 5, tokens: 10 },
      { userId: 'a', rank: 5, tokens: 1 },
      { userId: 'd', rank: 1, tokens: 99 },
    ]
    expect(ids(quartileSplit(tied)!.top)).toEqual(['b'])
    expect(ids(quartileSplit([...tied].reverse())!.top)).toEqual(['b'])
    expect(ids(quartileSplit(tied)!.rest)).toEqual(['c', 'a', 'd'])
  })
})

describe('median', () => {
  it('takes the middle of odd counts, the mean of the middle two of even ones', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

const person = (over: Partial<PracticePerson> = {}): PracticePerson => ({
  activeDays: 4,
  days: { mcp: 0, skills: 0, subagents: 0, plan: 0, sdk: null },
  mcpServers: 0,
  cacheHitRate: null,
  ...over,
})

describe('practiceGroup', () => {
  it('counts shares of people, median day shares, and leaves out people with no cache rate', () => {
    const g = practiceGroup([
      person({ days: { mcp: 2, skills: 0, subagents: 0, plan: 0, sdk: null }, mcpServers: 3, cacheHitRate: 90 }),
      person({ days: { mcp: 4, skills: 1, subagents: 0, plan: 0, sdk: null }, mcpServers: 1 }),
      person({ mcpServers: 2, cacheHitRate: 80 }),
    ])
    expect(g.users).toBe(3)
    expect(g.uses.mcp).toBeCloseTo(2 / 3)
    expect(g.uses.skills).toBeCloseTo(1 / 3)
    expect(g.dayShare.mcp).toBe(0.5)
    expect(g.mcpServers).toBe(2)
    expect(g.cacheHitRate).toBe(85)
  })

  it('has a null cache rate when no one has Claude tokens', () => {
    expect(practiceGroup([person(), person()]).cacheHitRate).toBeNull()
  })
})

const group = (uses: Partial<PracticeGroup['uses']> = {}, cacheHitRate: number | null = null): PracticeGroup => ({
  users: 4,
  uses: { mcp: 0, skills: 0, subagents: 0, plan: 0, ...uses },
  dayShare: { mcp: 0, skills: 0, subagents: 0, plan: 0 },
  mcpServers: 0,
  cacheHitRate,
})

describe('practiceTips', () => {
  it('fires each feature rule at 0.25 and not one step below', () => {
    expect(practiceTips(group({ mcp: 0.75 }), group({ mcp: 0.5 }))).toEqual([{ id: 'mcp', gap: 0.25 }])
    expect(practiceTips(group({ mcp: 0.74 }), group({ mcp: 0.5 }))).toEqual([])
  })

  it('fires the cache rule at 10 points and not below, and skips it when a side is unknown', () => {
    expect(practiceTips(group({}, 90), group({}, 80))).toEqual([{ id: 'cache', gap: 0.1 }])
    expect(practiceTips(group({}, 89.9), group({}, 80))).toEqual([])
    expect(practiceTips(group({}, 90), group({}, null))).toEqual([])
  })

  it('returns at most 3, largest gap first', () => {
    const tips = practiceTips(group({ mcp: 1, skills: 0.5, subagents: 1, plan: 0.75 }, 99), group({}, 50))
    expect(tips.map((t) => t.id)).toEqual(['mcp', 'subagents', 'plan'])
  })

  it('fires nothing when the rest do better', () => {
    expect(practiceTips(group({}, 50), group({ mcp: 1 }, 90))).toEqual([])
  })
})
