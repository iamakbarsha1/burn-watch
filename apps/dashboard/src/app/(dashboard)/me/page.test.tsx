import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MyUsageResponse } from '@burn-watch/shared'

const state = vi.hoisted(() => ({
  usage: null as MyUsageResponse | null,
  asked: [] as string[][],
}))

vi.mock('@/lib/api', () => ({
  fetchMyUsage: async (from: string, to: string) => {
    state.asked.push([from, to])
    if (!state.usage) throw new Error('down')
    return state.usage
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
  streak: { current: 4, longest: 18, lastActive: '2026-11-20' },
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
  ...over,
})

const NOV = { from: '2026-11-01', to: '2026-11-30' }

beforeEach(() => {
  state.usage = usage()
  state.asked = []
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

  it('shows active days against the range, both streaks, tokens, sessions and cost', async () => {
    const html = await render(NOV)
    expect(html).toContain('12 of 30')
    expect(html).toContain('4 days')
    expect(html).toContain('Longest 18 days. Only visible to you.')
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
      state.usage = usage({ onboarding: onboarding({ state: 'missed', dayOfWindow: 14 }) })
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
