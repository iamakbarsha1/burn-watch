import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FreeTierResponse, McpInventoryResponse } from '@burn-watch/shared'

const state = vi.hoisted(() => ({
  role: 'admin' as string | null,
  data: null as FreeTierResponse | null,
  mcp: null as McpInventoryResponse | null,
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
  fetchMcpInventory: async () => {
    if (!state.mcp) throw new Error('down')
    return state.mcp
  },
}))
vi.mock('@/components/TeamFilter', () => ({ TeamFilter: () => null }))
vi.mock('./McpApprovalButton', () => ({
  McpApprovalButton: ({ server, approved }: { server: string; approved: boolean }) =>
    `[${approved ? 'revoke' : 'approve'}:${server}]`,
}))

const { default: GovernancePage } = await import('./page')

const render = async () =>
  renderToStaticMarkup(await GovernancePage({ searchParams: Promise.resolve({ from: '2026-11-01', to: '2026-11-05' }) }))

beforeEach(() => {
  state.role = 'admin'
  state.data = { rows: [], byTeam: [] }
  state.mcp = { servers: [], unusedApprovals: [] }
})

const MCP: McpInventoryResponse = {
  servers: [
    {
      server: 'playwright',
      source: 'local',
      approved: true,
      note: 'browser tests',
      users: [{ userId: 'u1', name: 'Ada' }],
      calls: 40,
      days: 2,
      lastDate: '2026-11-05',
    },
    {
      server: 'claude_ai_Neon',
      source: 'claude.ai',
      approved: false,
      note: null,
      users: [{ userId: 'u2', name: 'Bo' }],
      calls: 3,
      days: 1,
      lastDate: '2026-11-03',
    },
  ],
  unusedApprovals: [{ server: 'context7', note: null }],
}

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

  it('shows the MCP empty state', async () => {
    expect(await render()).toContain('No MCP server calls in this range.')
  })

  it('lists MCP servers with badges and admin buttons, including unused approvals', async () => {
    state.mcp = MCP
    const html = await render()
    expect(html).toContain('2 servers, 1 not approved, used by 2 people')
    expect(html).toContain('claude.ai connector')
    expect(html).toContain('not approved')
    expect(html).toContain('browser tests')
    expect(html).toContain('[revoke:playwright]')
    expect(html).toContain('[approve:claude_ai_Neon]')
    expect(html).toContain('[revoke:context7]')
  })

  it('hides the approval buttons from a manager', async () => {
    state.role = 'manager'
    state.mcp = MCP
    const html = await render()
    expect(html).toContain('claude_ai_Neon')
    expect(html).not.toContain('[approve:')
    expect(html).not.toContain('[revoke:')
  })

  it('says so when MCP usage cannot be read', async () => {
    state.mcp = null
    expect(await render()).toContain('Could not read MCP usage')
  })
})
