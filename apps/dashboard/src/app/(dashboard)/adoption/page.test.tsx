import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { IdleSeatsResponse } from '@burn-watch/shared'

const state = vi.hoisted(() => ({
  role: 'admin' as string | null,
  data: null as IdleSeatsResponse | null,
  asked: [] as number[],
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
}))
vi.mock('@/lib/session', () => ({ getUserRole: async () => state.role }))
vi.mock('@/lib/api', () => ({
  fetchTeams: async () => [],
  fetchIdleSeats: async (idleDays: number) => {
    state.asked.push(idleDays)
    if (!state.data) throw new Error('down')
    return state.data
  },
}))
vi.mock('@/components/TeamFilter', () => ({ TeamFilter: () => null }))

const { default: AdoptionPage } = await import('./page')

const render = async (params: Record<string, string> = {}) =>
  renderToStaticMarkup(await AdoptionPage({ searchParams: Promise.resolve(params) }))

const empty = (orgSeats: number | null): IdleSeatsResponse => ({
  idleDays: 14,
  rows: [],
  byAgent: [],
  byTeam: [],
  totalMonthlyUsd: 0,
  orgSeats,
})

beforeEach(() => {
  state.role = 'admin'
  state.data = empty(0)
  state.asked = []
})

describe('AdoptionPage', () => {
  it('redirects a developer', async () => {
    state.role = 'developer'
    await expect(render()).rejects.toThrow('redirect:/')
  })

  it('points an admin with no seats to Admin > Seats', async () => {
    const html = await render()
    expect(html).toContain('No seats entered yet.')
    expect(html).toContain('href="/admin"')
  })

  it('says nothing is idle when seats exist, using the chosen idleDays', async () => {
    state.data = empty(3)
    const html = await render({ idleDays: '30', from: '2026-11-01' })
    expect(state.asked).toEqual([30])
    expect(html).toContain('No seats idle for 30+ days.')
    // The form keeps other params when idleDays changes.
    expect(html).toContain('name="from" value="2026-11-01"')
  })

  it('falls back to 14 days for a value the API would reject', async () => {
    await render({ idleDays: '0' })
    await render({ idleDays: 'abc' })
    expect(state.asked).toEqual([14, 14])
  })

  it('shows a manager the idle empty state, not the admin one', async () => {
    state.role = 'manager'
    state.data = empty(null)
    const html = await render()
    expect(html).toContain('No seats idle for 14+ days.')
    expect(html).not.toContain('No seats entered yet.')
  })

  it('renders rows in API order with the summary and a "never" label', async () => {
    state.data = {
      idleDays: 14,
      rows: [
        {
          userId: 'u2',
          userName: 'Bo',
          teams: [],
          agent: 'copilot',
          startDate: '2026-10-01',
          lastUsed: null,
          daysIdle: 41,
          monthlyPriceUsd: 19,
          costSinceUsedUsd: 25.6,
        },
        {
          userId: 'u1',
          userName: 'Ada',
          teams: ['Platform'],
          agent: 'claude',
          startDate: '2026-08-01',
          lastUsed: '2026-11-02',
          daysIdle: 20,
          monthlyPriceUsd: 30,
          costSinceUsedUsd: 19.73,
        },
      ],
      byAgent: [
        { agent: 'claude', seats: 1, monthlyUsd: 30 },
        { agent: 'copilot', seats: 1, monthlyUsd: 19 },
      ],
      byTeam: [{ teamId: 't1', teamName: 'Platform', seats: 1, monthlyUsd: 30 }],
      totalMonthlyUsd: 49,
      orgSeats: 2,
    }
    const html = await render()
    expect(html).toContain('2 idle seats, $49.00/month')
    expect(html).toContain('never')
    expect(html).toContain('2026-11-02')
    expect(html).toContain('Platform')
    expect(html.indexOf('Bo')).toBeLessThan(html.indexOf('Ada'))
  })

  it('says so when the API is down', async () => {
    state.data = null
    expect(await render()).toContain('Could not read idle seats')
  })
})
