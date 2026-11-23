import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ClaudeAccountsResponse, FreeTierResponse, McpInventoryResponse, ViolationsResponse } from '@burn-watch/shared'

const state = vi.hoisted(() => ({
  role: 'admin' as string | null,
  data: null as FreeTierResponse | null,
  mcp: null as McpInventoryResponse | null,
  violations: null as ViolationsResponse | null,
  count: 0,
  accounts: null as ClaudeAccountsResponse | null,
  accountsRead: 0,
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
  fetchViolations: async () => {
    if (!state.violations) throw new Error('down')
    return state.violations
  },
  fetchViolationCount: async () => state.count,
  fetchClaudeAccounts: async () => {
    state.accountsRead++
    if (!state.accounts) throw new Error('down')
    return state.accounts
  },
  fetchMcpInventory: async () => {
    if (!state.mcp) throw new Error('down')
    return state.mcp
  },
}))
vi.mock('@/components/TeamFilter', () => ({ TeamFilter: () => null }))
vi.mock('./AgentPolicyForm', () => ({
  AgentPolicyForm: ({ policy, seen }: { policy: { agent: string }; seen: string[] }) =>
    `[edit:${policy.agent}:${seen.join('|')}]`,
}))
vi.mock('./ClaudeOrgsForm', () => ({
  ClaudeOrgsForm: ({ orgs }: { orgs: { label: string; ours: boolean }[] }) =>
    `[orgs:${orgs.map((o) => `${o.label}${o.ours ? '*' : ''}`).join('|')}]`,
}))
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
  state.violations = {
    policies: (['claude', 'qwen', 'gemini', 'codex', 'copilot'] as const).map((agent) => ({
      agent,
      rule: 'unset' as const,
      models: [],
      note: null,
    })),
    rows: [],
    byTeam: [],
    seenModels: {},
  }
  state.count = 0
  state.accounts = null
  state.accountsRead = 0
})

const ACCOUNTS: ClaudeAccountsResponse = {
  from: '2026-11-01',
  to: '2026-11-05',
  coverage: { users: 3, hashed: 2 },
  companyOrgSet: false,
  seatsEntered: 0,
  companyOrgUsers: null,
  orgs: [{ id: 'c'.repeat(64), label: 'Claude org 1', users: 2, days: 4, ours: false, includesYou: true }],
  accounts: [{ label: 'Account 1', users: 2, days: 4, shared: true }],
  people: [
    { userId: 'u1', name: 'Ada', teamIds: [], hashedDays: 3, accounts: ['Account 1'], outsideOrgDays: null, claudeSeat: false, flags: ['shared'] },
    { userId: 'u3', name: 'Cy', teamIds: [], hashedDays: 1, accounts: ['Account 2'], outsideOrgDays: null, claudeSeat: false, flags: [] },
  ],
}

const VIOLATIONS: ViolationsResponse = {
  policies: [
    { agent: 'claude', rule: 'models', models: ['claude-opus-5'], note: 'Opus only' },
    { agent: 'qwen', rule: 'blocked', models: [], note: null },
    { agent: 'gemini', rule: 'allowed', models: [], note: null },
    { agent: 'codex', rule: 'unset', models: [], note: null },
    { agent: 'copilot', rule: 'unset', models: [], note: null },
  ],
  rows: [
    {
      userId: 'u1',
      userName: 'Ada',
      userEmail: 'ada@x.test',
      teams: [],
      agent: 'claude',
      modelName: 'claude-opus-5-5',
      reason: 'model-not-listed',
      days: 2,
      tokens: 500,
      firstDate: '2026-11-01',
      lastDate: '2026-11-05',
    },
  ],
  byTeam: [{ teamId: null, teamName: null, users: 1, tokens: 500 }],
  seenModels: { claude: ['claude-opus-5', 'claude-opus-5-5'] },
}

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

  it('shows the policy with badges, violations and admin edit forms', async () => {
    state.violations = VIOLATIONS
    const html = await render()
    expect(html).toContain('listed models only')
    expect(html).toContain('claude-opus-5')
    expect(html).toContain('Opus only')
    expect(html).toContain('blocked')
    expect(html).toContain('not set')
    expect(html).toContain('model not listed')
    expect(html).toContain('claude-opus-5-5')
    expect(html).toContain('[edit:claude:claude-opus-5|claude-opus-5-5]')
  })

  it('shows the violation empty state', async () => {
    expect(await render()).toContain('No usage outside the policy in this range.')
  })

  it('hides the edit forms and the banner from a manager', async () => {
    state.role = 'manager'
    state.violations = VIOLATIONS
    state.count = 3
    const html = await render()
    expect(html).toContain('model not listed')
    expect(html).not.toContain('[edit:')
    expect(html).not.toContain('outside the policy in the last 30 days')
  })

  it('shows the 30-day banner to an admin', async () => {
    state.count = 3
    expect(await render()).toContain('3 uses of an agent or model outside the policy in the last 30 days.')
  })

  it('says so when the policy cannot be read', async () => {
    state.violations = null
    expect(await render()).toContain('Could not read the policy')
  })

  it('shows Claude accounts to an admin: coverage, unset org prompt, flags, quiet rows folded', async () => {
    state.accounts = ACCOUNTS
    const html = await render()
    expect(html).toContain('Account data from 2 of 3 Claude Code users. The rest need agent 0.4 or later.')
    expect(html).toContain('Mark your company’s Claude org')
    expect(html).toContain('[orgs:Claude org 1]')
    expect(html).toContain('Shared account')
    expect(html).toContain('Show all (1 more)')
    expect(html).not.toMatch(/[0-9a-f]{64}/)
  })

  it('shows the seat line once the company org is set', async () => {
    state.accounts = { ...ACCOUNTS, companyOrgSet: true, seatsEntered: 6, companyOrgUsers: 5 }
    state.accounts.orgs = [{ ...ACCOUNTS.orgs[0], ours: true }]
    const html = await render()
    expect(html).toContain('[orgs:Claude org 1*]')
    expect(html).toContain('6 Claude seats. 5 people seen on the company org.')
    expect(html).not.toContain('Mark your company')
  })

  it('links to Admin when the company org is set but no seats are entered', async () => {
    state.accounts = { ...ACCOUNTS, companyOrgSet: true, companyOrgUsers: 1 }
    expect(await render()).toContain('Add seats in Admin')
  })

  it('says so when Claude accounts cannot be read', async () => {
    expect(await render()).toContain('Could not read Claude accounts')
  })

  it('never reads or shows Claude accounts to a manager', async () => {
    state.role = 'manager'
    state.accounts = ACCOUNTS
    const html = await render()
    expect(html).not.toContain('Claude accounts')
    expect(state.accountsRead).toBe(0)
  })
})
