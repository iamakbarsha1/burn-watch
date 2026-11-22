import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AuditQuery, AuditRow } from '@burn-watch/shared'

const state = vi.hoisted(() => ({
  role: 'admin' as string | null,
  rows: [] as AuditRow[] | null,
  asked: [] as AuditQuery[],
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/lib/session', () => ({ getUserRole: async () => state.role }))
vi.mock('@/lib/api', () => ({
  fetchAdminUsers: async () => [{ id: 'u2', name: 'Priya' }],
  fetchAuditLog: async (q: AuditQuery) => {
    state.asked.push(q)
    if (!state.rows) throw new Error('down')
    return state.rows
  },
}))

const { default: AuditPage } = await import('./page')

const render = async (params: Record<string, string> = {}) =>
  renderToStaticMarkup(await AuditPage({ searchParams: Promise.resolve(params) }))

const view: AuditRow = {
  id: 'e1',
  at: '2026-11-05T09:12:00.000Z',
  lastAt: '2026-11-05T15:00:00.000Z',
  count: 4,
  kind: 'view',
  action: 'view.governance',
  actor: { id: 'u1', name: 'Asha', role: 'manager' },
  target: { type: 'team', id: 't1', label: 'Platform' },
  detail: { people: 6 },
}

beforeEach(() => {
  state.role = 'admin'
  state.rows = []
  state.asked = []
})

describe('AuditPage', () => {
  it.each(['manager', 'developer'])('redirects a %s', async (role) => {
    state.role = role
    await expect(render()).rejects.toThrow('redirect:/')
    expect(state.asked).toEqual([])
  })

  it('passes the URL filters to the API and ignores an unknown area', async () => {
    await render({ from: '2026-11-01', to: '2026-11-05', kind: 'view', actorId: 'u2', action: 'team.', offset: '100' })
    await render({ action: 'bogus.', kind: 'nope' })
    expect(state.asked[0]).toEqual({ from: '2026-11-01', to: '2026-11-05', kind: 'view', actorId: 'u2', action: 'team.', limit: 100, offset: 100 })
    expect(state.asked[1]).toMatchObject({ kind: 'all', action: undefined, offset: 0 })
  })

  it('shows a view as one row with its count and a plain sentence', async () => {
    state.rows = [view]
    const html = await render()
    expect(html).toContain('Viewed Governance for Platform (6 people)')
    expect(html).toContain('4 times')
    expect(html).toContain('Asha')
  })

  it('shows an org target by its name, or "Organization" for an old row with only the id', async () => {
    const org: AuditRow = { ...view, kind: 'action', action: 'org.leaderboard_settings', detail: { developerView: 'full', showNames: true, showOthersCost: false } }
    state.rows = [
      { ...org, id: 'e1', target: { type: 'org', id: '11111111-1111-4111-8111-111111111111', label: 'Acme' } },
      { ...org, id: 'e2', target: { type: 'org', id: '11111111-1111-4111-8111-111111111111', label: null } },
    ]
    const html = await render()
    expect(html).toContain('>Acme</td>')
    expect(html).toContain('>Organization</td>')
    expect(html).not.toContain('11111111-1111-4111-8111-111111111111')
  })

  it('offers Load more only when a full page came back', async () => {
    expect(await render()).not.toContain('Load more')
    state.rows = Array.from({ length: 100 }, (_, i) => ({ ...view, id: `e${i}` }))
    expect(await render({ kind: 'view' })).toContain('href="/audit?kind=view&amp;offset=100"')
  })

  it('says so when the API is down', async () => {
    state.rows = null
    expect(await render()).toContain('Could not read the audit log')
  })
})
