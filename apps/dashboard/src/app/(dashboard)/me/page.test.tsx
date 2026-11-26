import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AuditMeResponse, MyUsageResponse } from '@burn-watch/shared'

const state = vi.hoisted(() => ({
  usage: null as MyUsageResponse | null,
  asked: [] as string[][],
  audit: null as AuditMeResponse | null,
}))

vi.mock('@/lib/api', () => ({
  fetchMyUsage: async (from: string, to: string) => {
    state.asked.push([from, to])
    if (!state.usage) throw new Error('down')
    return state.usage
  },
  fetchAuditMe: async () => {
    if (!state.audit) throw new Error('down')
    return state.audit
  },
}))

vi.mock('./actions', () => ({ helpVolunteerAction: vi.fn() }))

const { default: MyUsagePage } = await import('./page')

const render = async (params: Record<string, string> = {}) =>
  renderToStaticMarkup(await MyUsagePage({ searchParams: Promise.resolve(params) }))

const usage = (over: Partial<MyUsageResponse> = {}): MyUsageResponse => ({
  from: '2026-11-01',
  to: '2026-11-30',
  rangeDays: 30,
  activeDays: 12,
  consecutiveDays: { current: 4, longest: 18, lastActive: '2026-11-20' },
  totalTokens: 1_500_000,
  sessions: 42,
  totalCostUsd: 19,
  agents: [
    { agent: 'claude', tokens: 1_400_000, costUsd: 17.5 },
    { agent: 'codex', tokens: 100_000, costUsd: 1.5 },
  ],
  features: { agents: ['claude', 'codex'], mcpServers: ['github', 'neon'] },
  onboarding: null,
  helpVolunteer: false,
  seats: [],
  freeTier: [],
  setupChecks: [],
  accountFlags: [],
  ...over,
})

const NOV = { from: '2026-11-01', to: '2026-11-30' }

beforeEach(() => {
  state.usage = usage()
  state.asked = []
  state.audit = { from: '2026-08-29', to: '2026-11-26', rows: [] }
})

describe('MyUsagePage', () => {
  it('asks for the picked range and shows it', async () => {
    const html = await render(NOV)
    expect(state.asked).toEqual([['2026-11-01', '2026-11-30']])
    expect(html).toContain('My usage')
  })

  it('says only you can see it', async () => {
    expect(await render(NOV)).toContain(
      'Only you can see this page&#x27;s numbers. Managers and admins see team totals, never yours.',
    )
  })

  it('shows active days against the range, both consecutive-day runs, tokens, sessions and cost', async () => {
    const html = await render(NOV)
    expect(html).toContain('12 of 30')
    expect(html).toContain('4 days')
    expect(html).toContain('Longest 18 days. Only visible to you.')
    expect(html).toContain('Consecutive days')
    expect(html).not.toMatch(/streak/i)
    expect(html).toContain('42')
    expect(html).toContain('$19.00')
  })

  it('lists tokens and cost per agent, and the agents and MCP servers used', async () => {
    const html = await render(NOV)
    expect(html).toContain('$17.50')
    expect(html).toContain('$1.50')
    expect(html).toContain('Claude, Codex')
    expect(html).toContain('github, neon')
  })

  it('has no ranking words', async () => {
    expect(await render(NOV)).not.toMatch(/leaderboard|rank|score/i)
  })

  it('says so when nothing was used, and when the API fails', async () => {
    state.usage = usage({ activeDays: 0, agents: [], features: { agents: [], mcpServers: [] } })
    expect(await render(NOV)).toContain('No usage in this range.')
    state.usage = null
    expect(await render(NOV)).toContain('Could not read your usage.')
  })

  describe('Your first 14 days', () => {
    const onboarding = (over: Partial<NonNullable<MyUsageResponse['onboarding']>> = {}) => ({
      firstSync: '2026-11-20',
      state: 'inProgress' as const,
      activeWeek1: 3,
      activeWeek2: 1,
      features: ['mcp' as const],
      dayOfWindow: 9,
      ...over,
    })

    it('is hidden before the first sync', async () => {
      expect(await render(NOV)).not.toContain('Your first 14 days')
    })

    it('shows the state, the day, and each rule as done or n of m', async () => {
      state.usage = usage({ onboarding: onboarding() })
      const html = await render(NOV)
      expect(html).toContain('Your first 14 days')
      expect(html).toContain('From your first sync on 2026-11-20. Only you can see this.')
      expect(html).toContain('In progress')
      expect(html).toContain('Day 9 of 14')
      expect(html).toMatch(/Tokens on 2 or more days in week 1<\/span><span[^>]*>Done</)
      expect(html).toContain('1 of 2 days')
      expect(html).toContain('1 of 2 features')
      expect(html).toContain('Features used: MCP.')
    })

    it('uses neutral words for each state', async () => {
      state.usage = usage({ onboarding: onboarding({ state: 'onboarded', activeWeek2: 2, features: ['mcp', 'plan'], dayOfWindow: 14 }) })
      expect(await render(NOV)).toContain('>Done<')
      state.usage = usage({ onboarding: onboarding({ state: 'windowEnded', dayOfWindow: 14 }) })
      const ended = await render(NOV)
      expect(ended).toContain('Window ended')
      expect(ended).not.toContain('Day 14 of 14')
      expect(ended).not.toMatch(/missed|fail/i)
    })
  })

  describe('Happy to help', () => {
    it('shows the checkbox unchecked by default, with what it does', async () => {
      const html = await render(NOV)
      expect(html).toContain('Happy to help with Claude Code')
      expect(html).toContain('Your name shows on the Adoption page under your teams. Turn it off any time.')
      expect(html).toMatch(/<input type="checkbox" name="helpVolunteer"\/>/)
    })

    it('is checked when the person opted in', async () => {
      state.usage = usage({ helpVolunteer: true })
      expect(await render(NOV)).toMatch(/<input type="checkbox" name="helpVolunteer" checked=""\/>/)
    })
  })
})

describe('Your setup', () => {
  it('shows an empty state when there is nothing to note', async () => {
    const html = await render(NOV)
    expect(html).toContain('Your setup')
    expect(html).toContain('Nothing to note')
  })

  it('shows own seats, free-tier use, setup checks and account flags in plain words', async () => {
    state.usage = usage({
      seats: [
        { agent: 'claude', daysUnused: 0 },
        { agent: 'copilot', daysUnused: 21 },
      ],
      freeTier: [{ agent: 'qwen', modelName: 'qwen3-coder', reason: 'free-tier-agent', people: 1, days: 3, tokens: 9000 }],
      setupChecks: [{ agent: 'gemini', modelName: 'gemini-2.5-pro', reason: 'agent-blocked', days: 2, tokens: 500 }],
      accountFlags: ['outside-org'],
    })
    const html = await render(NOV)
    expect(html).toContain('Claude seat')
    expect(html).toContain('in use')
    expect(html).toContain('unused for 21 days')
    expect(html).toContain('Qwen · qwen3-coder')
    expect(html).toContain('free tier: the provider may train on what you send (3 days)')
    expect(html).toContain('Gemini · gemini-2.5-pro')
    expect(html).toContain('outside the org&#x27;s agent rules')
    expect(html).toContain('Outside company org')
    expect(html).not.toContain('Nothing to note')
    expect(html).not.toMatch(/violation|idle/i)
  })
})

describe('Who viewed my data', () => {
  const at = '2026-11-05T09:12:00.000Z'

  it('lists each view with the viewer, what they opened, what it covered, the day and the count', async () => {
    state.audit = {
      from: '2026-08-29',
      to: '2026-11-26',
      rows: [
        { at, lastAt: at, count: 3, surface: 'adoption', viewer: { name: 'Priya', role: 'manager' }, scope: 'managed teams' },
        { at, lastAt: null, count: 1, surface: 'governance', viewer: { name: 'Sam', role: 'admin' }, scope: 'org' },
        { at, lastAt: null, count: 2, surface: 'overview', viewer: { name: null, role: 'manager' }, scope: 'Platform' },
      ],
    }
    const html = await render(NOV)
    expect(html).toContain('Who viewed my data')
    expect(html).toContain('Each view counts the people it covered at the time.')
    expect(html).toContain('Priya <span class="text-ink-2">(manager)</span>')
    expect(html).toContain('Teams they manage')
    expect(html).toContain('Governance')
    expect(html).toContain('Whole org')
    expect(html).toContain('A removed user')
    expect(html).toContain('Platform')
    expect(html).toContain('2026-11-05')
    expect(html).not.toContain('No one has viewed')
  })

  it('says so when no one has viewed data that includes you', async () => {
    expect(await render(NOV)).toContain('No one has viewed data that includes you in the last 90 days.')
  })

  it('shows the rest of the page when the read fails', async () => {
    state.audit = null
    const html = await render(NOV)
    expect(html).toContain('Could not read who viewed your data.')
    expect(html).toContain('Your setup')
    expect(html).toContain('$19.00')
  })
})
