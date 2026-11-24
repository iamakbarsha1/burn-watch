import { describe, it, expect } from 'vitest'
import type { PracticeGroup } from '@burn-watch/shared'
import {
  MIN_QUARTILE_PEOPLE,
  median,
  practiceGroup,
  practiceTips,
  quartileSplit,
  recommendedSetup,
  teamVolunteers,
  type PracticePerson,
} from './quartile.js'

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, rank: n - i, tokens: 0 }))
const ids = (xs: { userId: string }[]) => xs.map((x) => x.userId)

describe('quartileSplit', () => {
  it('refuses until the top group itself reaches MIN_GROUP_SIZE, and splits from there', () => {
    expect(MIN_QUARTILE_PEOPLE).toBe(17)
    expect(quartileSplit(people(16))).toBeNull()
    expect(ids(quartileSplit(people(17))!.top)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4'])
    expect(quartileSplit(people(17))!.rest).toHaveLength(12)
    expect(quartileSplit(people(21))!.top).toHaveLength(6)
  })

  it('breaks a tie at the cut by tokens, then userId, whatever the input order', () => {
    const lead = ['p0', 'p1', 'p2', 'p3'].map((userId) => ({ userId, rank: 10, tokens: 0 }))
    const tail = Array.from({ length: 10 }, (_, i) => ({ userId: `z${i}`, rank: 1, tokens: 0 }))
    const tied = [
      ...lead,
      { userId: 'c', rank: 5, tokens: 10 },
      { userId: 'b', rank: 5, tokens: 10 },
      { userId: 'a', rank: 5, tokens: 1 },
      ...tail,
    ]
    expect(ids(quartileSplit(tied)!.top)).toEqual(['p0', 'p1', 'p2', 'p3', 'b'])
    expect(ids(quartileSplit([...tied].reverse())!.top)).toEqual(['p0', 'p1', 'p2', 'p3', 'b'])
    expect(ids(quartileSplit(tied)!.rest).slice(0, 2)).toEqual(['c', 'a'])
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

const member = (userId: string, name: string, helpVolunteer: boolean, mcp = 0, skills = 0, plan = 0) => ({
  userId,
  name,
  helpVolunteer,
  days: { mcp, skills, subagents: 0, plan, sdk: 1 },
})

describe('teamVolunteers', () => {
  it('lists only people who volunteered, by name, never picked by usage', () => {
    const team = [member('z', 'Zed', true), member('top', 'Top user', false, 9, 9, 9), member('a', 'Amy', true)]
    expect(teamVolunteers(team).map((v) => v.name)).toEqual(['Amy', 'Zed'])
    expect(teamVolunteers([member('top', 'Top user', false, 9, 9, 9)])).toEqual([])
  })

  it('can help with what they used and under half the team used', () => {
    // 4 people: MCP used by 3, skills by 2 (exactly half), plan by 1.
    const team = [
      member('a', 'Amy', true, 1, 1, 1),
      member('b', 'Bo', false, 1, 1, 0),
      member('c', 'Cy', false, 1, 0, 0),
      member('d', 'Di', false),
    ]
    expect(teamVolunteers(team)).toEqual([{ userId: 'a', name: 'Amy', canHelpWith: ['plan'] }])
  })
})

describe('recommendedSetup', () => {
  const p = (...servers: string[]) => ({ servers })
  const UUID = '0b5d1a2e-3c4f-4a6b-8c9d-0e1f2a3b4c5d'

  it('needs a group of 2', () => {
    expect(recommendedSetup([p('github')], [p('github')], null)).toEqual({ reason: 'smallGroup', items: [] })
  })

  it('keeps servers used by half the group and 2 people, and skips unnamed ones', () => {
    const group = [p('github', 'linear', UUID), p('github', UUID), p('linear', 'solo'), p()]
    const everyone = [...group, p('github'), p('github')]
    const { items } = recommendedSetup(group, everyone, null)
    expect(items).toEqual([
      { key: 'github', source: 'local', topUsers: 2, teamUsers: 4, approved: null },
      { key: 'linear', source: 'local', topUsers: 2, teamUsers: 2, approved: null },
    ])
  })

  it('drops a server under half of the group even with 2 users', () => {
    expect(recommendedSetup([p('a'), p('a'), p(), p(), p()], [], null).items).toEqual([])
  })

  it('maps sources and badges unapproved servers when approvals apply', () => {
    const group = [p('plugin_x_y', 'claude_ai_Gmail', 'github'), p('plugin_x_y', 'claude_ai_Gmail', 'github')]
    const { items } = recommendedSetup(group, group, new Set(['github']))
    expect(items.map((i) => [i.key, i.source, i.approved])).toEqual([
      ['claude_ai_Gmail', 'claude.ai', false],
      ['github', 'local', true],
      ['plugin_x_y', 'plugin', false],
    ])
  })
})
