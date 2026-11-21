import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FreeTierResponse } from '@burn-watch/shared'

const state = vi.hoisted(() => ({
  role: 'admin' as string | null,
  data: null as FreeTierResponse | null,
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
}))
vi.mock('@/lib/session', () => ({ getUserRole: async () => state.role }))
vi.mock('@/lib/api', () => ({
  fetchTeams: async () => [],
  fetchFreeTier: async () => {
    if (!state.data) throw new Error('down')
    return state.data
  },
}))
vi.mock('@/components/TeamFilter', () => ({ TeamFilter: () => null }))

const { default: GovernancePage } = await import('./page')

const render = async () =>
  renderToStaticMarkup(await GovernancePage({ searchParams: Promise.resolve({ from: '2026-11-01', to: '2026-11-05' }) }))

beforeEach(() => {
  state.role = 'admin'
  state.data = { rows: [], byTeam: [] }
})

describe('GovernancePage', () => {
  it('redirects a developer', async () => {
    state.role = 'developer'
    await expect(render()).rejects.toThrow('redirect:/')
  })

  it('shows the empty state with the Gemini gap note', async () => {
    const html = await render()
    expect(html).toContain('No free-tier usage in this range.')
    expect(html).toContain('BW-43')
  })

  it('renders a row with its reason badge', async () => {
    state.role = 'manager'
    state.data = {
      rows: [
        {
          userId: 'u1',
          userName: 'Ada',
          userEmail: 'ada@x.test',
          teams: ['Platform'],
          agent: 'qwen',
          modelName: 'coder-model',
          reason: 'free-tier-agent',
          days: 3,
          tokens: 900,
          firstDate: '2026-11-01',
          lastDate: '2026-11-05',
        },
      ],
      byTeam: [{ teamId: 't1', teamName: 'Platform', users: 1, tokens: 900 }],
    }
    const html = await render()
    expect(html).toContain('Ada')
    expect(html).toContain('coder-model')
    expect(html).toContain('free-tier agent')
    expect(html).toContain('Platform: 1 person')
  })

  it('says so when the API is down', async () => {
    state.data = null
    expect(await render()).toContain('Could not read free-tier usage')
  })
})
