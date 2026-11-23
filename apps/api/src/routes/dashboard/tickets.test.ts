import { describe, it, expect } from 'vitest'
import type { UserId } from '@burn-watch/db'
import { foldTickets, ticketKey, ticketTotals, type BranchGroup } from './tickets.js'

const P = new Set(['PROJ', 'WEB'])

describe('ticketKey', () => {
  it.each([
    ['PROJ-123-fix-login', 'PROJ-123'],
    ['feature/PROJ-123', 'PROJ-123'],
    ['fix-PROJ-7', 'PROJ-7'],
    ['foo_PROJ-1', 'PROJ-1'],
    ['proj-123-fix', 'PROJ-123'],
    ['UTF-8-WEB-9', 'WEB-9'],
    ['PROJ-1-and-WEB-2', 'PROJ-1'],
  ])('%s gives %s', (branch, key) => {
    expect(ticketKey(branch, P)).toBe(key)
  })

  it.each(['UTF-8', 'ISO-8601', 'SHA-256', 'RFC-7231', 'release-1', 'PROJ-0', 'PROJ-12345678', 'main', 'xPROJ-1'])(
    '%s gives null',
    (branch) => {
      expect(ticketKey(branch, P)).toBeNull()
    },
  )

  it('always gives null with an empty allowlist', () => {
    expect(ticketKey('PROJ-1', new Set())).toBeNull()
  })
})

describe('ticketTotals', () => {
  it('opens with the indexed org and date match, then unwinds projects and branches', () => {
    const p = ticketTotals({ orgId: 'O' as never, from: '2026-11-01' as never, to: '2026-11-05' as never })
    expect(p[0]).toEqual({ $match: { orgId: 'O', date: { $gte: '2026-11-01', $lte: '2026-11-05' } } })
    expect(p.slice(1, 3)).toEqual([{ $unwind: '$projectBreakdown' }, { $unwind: '$projectBreakdown.branches' }])
  })
})

const g = (branch: string, repo: string, cost: number, users: string[], days: string[], sessions = 1): BranchGroup => ({
  _id: { branch, repo },
  cost,
  sessions,
  users: users as UserId[],
  days,
})

describe('foldTickets', () => {
  const groups = [
    g('PROJ-1-a', 'api', 5, ['u1'], ['d1']),
    g('proj-1-b', 'web', 3, ['u2'], ['d1', 'd2'], 2),
    g('WEB-4-dark-mode', 'web', 1, ['u1'], ['d3']),
    g('UTF-8-fix', 'api', 2, ['u1'], ['d1']),
    g('fix/acme-leak', 'api', 0.5, ['u2'], ['d2']),
  ]

  it('folds one ticket across repos, rolls up by key, and keeps every cent', () => {
    const r = foldTickets(groups, ['PROJ', 'WEB'], false)
    expect(r.tickets).toEqual([
      { key: 'PROJ-1', cost: 8, sessions: 3, userCount: 2, repoCount: 2, days: 2 },
      { key: 'WEB-4', cost: 1, sessions: 1, userCount: 1, repoCount: 1, days: 1 },
    ])
    expect(r.projectKeys).toEqual([
      { prefix: 'PROJ', tickets: 1, cost: 8, sessions: 3, userCount: 2 },
      { prefix: 'WEB', tickets: 1, cost: 1, sessions: 1, userCount: 1 },
    ])
    expect(r.noTicket).toEqual({ cost: 2.5, sessions: 2 })
    const total = groups.reduce((s, x) => s + x.cost, 0)
    expect(r.tickets.reduce((s, t) => s + t.cost, 0) + r.noTicket.cost).toBe(total)
    expect(r.suggestions).toBeNull()
    // Branch names can be anything, so check each seeded name verbatim rather than a pattern.
    const json = JSON.stringify(foldTickets(groups, ['PROJ', 'WEB'], true))
    for (const x of groups) expect(json).not.toContain(x._id.branch)
  })

  it('suggests upper-case prefixes not yet allowed, as counts only', () => {
    const r = foldTickets(groups, ['WEB'], true)
    expect(r.suggestions).toEqual([
      { prefix: 'PROJ', branches: 1 },
      { prefix: 'UTF', branches: 1 },
    ])
  })

  it('puts everything under No ticket with no allowlist', () => {
    const r = foldTickets(groups, [], true)
    expect(r.tickets).toEqual([])
    expect(r.noTicket.cost).toBe(11.5)
    expect(r.suggestions!.map((s) => s.prefix)).toEqual(['PROJ', 'UTF', 'WEB'])
  })
})
