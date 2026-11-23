import { describe, it, expect } from 'vitest'
import type { UserId } from '@burn-watch/db'
import { groupAccounts, type AccountDay } from './accounts.js'

const A = 'a' as UserId
const B = 'b' as UserId
const C = 'c' as UserId
const h = (c: string) => c.repeat(64)
const day = (userId: UserId, date: string, acc: string[] | null, org: string[] | null): AccountDay => ({
  userId,
  date: date as AccountDay['date'],
  accountHashes: acc,
  claudeOrgHashes: org,
})
const opts = (over: Partial<Parameters<typeof groupAccounts>[1]> = {}) => ({
  own: [],
  seated: new Set<UserId>(),
  seatsEntered: 0,
  viewerId: A,
  ...over,
})

describe('groupAccounts', () => {
  it('flags an account seen under two people as shared, and labels by first seen', () => {
    const r = groupAccounts(
      [
        day(A, '2026-11-02', [h('2')], [h('o')]),
        day(B, '2026-11-01', [h('2')], [h('o')]),
        day(A, '2026-11-03', [h('1')], [h('o')]),
      ],
      opts(),
    )
    expect(r.accounts).toEqual([
      { label: 'Account 1', users: 2, days: 2, shared: true },
      { label: 'Account 2', users: 1, days: 1, shared: false },
    ])
    const a = r.people.find((p) => p.userId === A)!
    expect(a.accounts).toEqual(['Account 1', 'Account 2'])
    expect(a.flags).toEqual(['shared', 'several'])
    expect(r.people.find((p) => p.userId === B)!.flags).toEqual(['shared'])
  })

  it('counts null and empty hash fields as not hashed, but still as a Claude Code user', () => {
    const r = groupAccounts(
      [day(A, '2026-11-01', null, null), day(B, '2026-11-01', [], []), day(C, '2026-11-01', [h('1')], [h('o')])],
      opts(),
    )
    expect(r.coverage).toEqual({ users: 3, hashed: 1 })
    expect(r.people.map((p) => p.userId)).toEqual([C])
  })

  it('gives no outside-org count or flag until the company org is set', () => {
    const docs = [day(A, '2026-11-01', [h('1')], [h('o')]), day(A, '2026-11-02', [h('1')], [h('p')])]
    const unset = groupAccounts(docs, opts())
    expect(unset.people[0]).toMatchObject({ outsideOrgDays: null, flags: [] })
    expect(unset.orgs.map((o) => o.ours)).toEqual([false, false])

    const set = groupAccounts(docs, opts({ own: [h('o')] }))
    expect(set.people[0]).toMatchObject({ outsideOrgDays: 1, flags: ['outside-org'] })
    expect([unset.companyOrgUsers, set.companyOrgUsers]).toEqual([null, 1])
    expect(set.orgs).toEqual([
      { id: h('o'), label: 'Claude org 1', users: 1, days: 1, ours: true, includesYou: true },
      { id: h('p'), label: 'Claude org 2', users: 1, days: 1, ours: false, includesYou: true },
    ])
  })

  it('counts a mixed day as outside, which is true for at least one session', () => {
    const r = groupAccounts([day(A, '2026-11-01', [h('1')], [h('o'), h('p')])], opts({ own: [h('o')] }))
    expect(r.people[0].outsideOrgDays).toBe(1)
  })

  it('compares seats only when seats exist and the company org is set', () => {
    const docs = [day(A, '2026-11-01', [h('1')], [h('p')]), day(B, '2026-11-01', [h('2')], [h('o')])]
    const seated = new Set([A])
    expect(groupAccounts(docs, opts({ seated, seatsEntered: 1 })).people.flatMap((p) => p.flags)).toEqual([])
    expect(groupAccounts(docs, opts({ own: [h('o')], seated })).people.map((p) => p.flags)).toEqual([['outside-org'], []])

    const r = groupAccounts(docs, opts({ own: [h('o')], seated, seatsEntered: 1 }))
    expect(r.people.map((p) => [p.userId, p.claudeSeat, p.flags])).toEqual([
      [A, true, ['outside-org', 'seat-no-use']],
      [B, false, ['use-no-seat']],
    ])
  })

  it('marks only orgs the viewer used as including you', () => {
    const r = groupAccounts([day(B, '2026-11-01', [h('2')], [h('o')])], opts())
    expect(r.orgs[0].includesYou).toBe(false)
  })
})
