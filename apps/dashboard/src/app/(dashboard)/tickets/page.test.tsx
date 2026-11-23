import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TicketUsageResponse } from '@burn-watch/shared'

const state = vi.hoisted(() => ({
  role: 'admin' as string | null,
  data: null as TicketUsageResponse | null,
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
}))
vi.mock('@/lib/session', () => ({ getUserRole: async () => state.role, getOrgId: async () => 'org' }))
vi.mock('@/lib/api', () => ({
  fetchTickets: async () => {
    if (!state.data) throw new Error('down')
    return state.data
  },
}))
vi.mock('./TicketSettingsForm', () => ({
  TicketSettingsForm: ({ prefixes, suggestions }: { prefixes: string[]; suggestions: string[] }) =>
    `[keys:${prefixes.join('|')};hint:${suggestions.join('|')}]`,
}))

const { default: TicketsPage } = await import('./page')
const render = async (extra: Record<string, string> = {}) =>
  renderToStaticMarkup(await TicketsPage({ searchParams: Promise.resolve({ from: '2026-11-01', to: '2026-11-05', ...extra }) }))

const DATA: TicketUsageResponse = {
  from: '2026-11-01',
  to: '2026-11-05',
  prefixes: ['PROJ'],
  tickets: [{ key: 'PROJ-1', cost: 8, sessions: 3, userCount: 2, repoCount: 2, days: 2 }],
  projectKeys: [{ prefix: 'PROJ', tickets: 1, cost: 8, sessions: 3, userCount: 2 }],
  noTicket: { cost: 2.5, sessions: 2 },
  suggestions: [{ prefix: 'WEB', branches: 3 }],
}

beforeEach(() => {
  state.role = 'admin'
  state.data = DATA
})

describe('TicketsPage', () => {
  it('shows both tables, the No ticket row and the admin form with hints', async () => {
    const html = await render()
    expect(html).toContain('PROJ-1')
    expect(html).toContain('Per project key')
    expect(html).toContain('No ticket')
    expect(html).toContain('[keys:PROJ;hint:WEB]')
  })

  it('asks an admin to set keys when none are set, and hides the tables', async () => {
    state.data = { ...DATA, prefixes: null, tickets: [], projectKeys: [] }
    const html = await render()
    expect(html).toContain('Set your Jira project keys below')
    expect(html).not.toContain('Per ticket')
  })

  it('tells a developer the admin has not set keys, with no form', async () => {
    state.role = 'developer'
    state.data = { ...DATA, prefixes: null, tickets: [], projectKeys: [], suggestions: null }
    const html = await render()
    expect(html).toContain('Your admin has not set Jira project keys yet')
    expect(html).not.toContain('[keys:')
  })

  it('shows the top 50 with a Show all link, and everything with all=1', async () => {
    const tickets = Array.from({ length: 51 }, (_, i) => ({ ...DATA.tickets[0], key: `PROJ-${i + 1}`, cost: 100 - i }))
    state.data = { ...DATA, tickets }
    const top = await render()
    expect(top).toContain('PROJ-50<')
    expect(top).not.toContain('PROJ-51<')
    expect(top).toContain('Show all 51 tickets')
    expect(await render({ all: '1' })).toContain('PROJ-51<')
  })

  it('says so when the API is down', async () => {
    state.data = null
    expect(await render()).toContain('Could not read ticket usage')
  })
})
