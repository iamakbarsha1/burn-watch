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
})
