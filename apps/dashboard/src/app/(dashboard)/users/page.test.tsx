import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LeaderboardEntry, Team } from '@burn-watch/shared'

const state = vi.hoisted(() => ({
  rows: [] as LeaderboardEntry[] | null,
  teams: [] as Team[],
  asked: [] as unknown[][],
  hidden: false as boolean | null,
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
}))
vi.mock('@/lib/session', () => ({ getOrgId: async () => 'org-1' }))
vi.mock('@/lib/api', () => ({
  fetchTeams: async () => state.teams,
  fetchLeaderboardSettings: async () => {
    if (state.hidden === null) throw new Error('down')
    return { developerView: 'full', showNames: true, showOthersCost: false, hideOnLeaderboard: state.hidden }
  },
  fetchLeaderboard: async (...args: unknown[]) => {
    state.asked.push(args)
    if (!state.rows) throw new Error('down')
    return state.rows
  },
}))
vi.mock('@/components/TeamFilter', () => ({ TeamFilter: () => <div>team-picker</div> }))
vi.mock('./HideNameForm', () => ({ HideNameForm: ({ hidden }: { hidden: boolean }) => <div>hide-form:{String(hidden)}</div> }))

const { default: LeaderboardPage } = await import('./page')

const render = async (params: Record<string, string> = {}) =>
  renderToStaticMarkup(await LeaderboardPage({ searchParams: Promise.resolve(params) }))

const agent = (tokens: number, costUsd: number | null) => ({ tokens, costUsd })
const row = (over: Partial<LeaderboardEntry> = {}): LeaderboardEntry => ({
  userId: 'u1',
  name: 'Ada',
  email: 'ada@example.com',
  claude: agent(900, 19),
  qwen: agent(0, 0),
  gemini: agent(0, 0),
  codex: agent(0, 0),
  copilot: agent(0, 0),
  totalCostUsd: 19,
  totalTokens: 900,
  sessions: 4,
  cacheHitRate: null,
  actualCostUsd: 3.2,
  apiSpendUsd: 0,
  valueMultiple: 5.9,
  rank: 1,
  outOf: 1,
  score: 87,
  activeDays: 12,
  streak: { current: 4, longest: 18, lastActive: '2026-11-20' },
  features: { agents: ['claude'], mcpServers: ['github', 'neon'] },
  ...over,
})

const NOV = { from: '2026-11-01', to: '2026-11-30' }

beforeEach(() => {
  state.rows = [row()]
  state.teams = []
  state.asked = []
  state.hidden = false
})

describe('LeaderboardPage', () => {
  it('shows active days against the range length, streaks and features, with no cost by default', async () => {
    const html = await render(NOV)
    expect(html).toContain('Leaderboard')
    expect(html).toContain('ranked by active days')
    expect(html).toContain('12 of 30')
    expect(html).toContain('best 18')
    expect(html).toContain('title="github, neon"')
    expect(html).not.toContain('Value')
    expect(html).not.toContain('$19.00')
    expect(html).not.toContain('Cache hit')
    expect(html).toContain('Weekends do not break a streak')
    expect(html).toContain('40% active days, 30% current streak, 20% tokens, 10% agents and MCP servers tried')
  })

  it('offers Show cost, keeping the range in the link', async () => {
    const html = await render(NOV)
    expect(html).toContain('href="/users?from=2026-11-01&amp;to=2026-11-30&amp;cost=1"')
  })

  it('adds the cost columns with cost=1, and a dash where the API withheld cost', async () => {
    state.rows = [
      row(),
      row({ userId: 'person-2', name: 'Person 2', email: '', totalCostUsd: null, actualCostUsd: null, apiSpendUsd: null, valueMultiple: null, claude: agent(5, null) }),
    ]
    const html = await render({ ...NOV, cost: '1' })
    expect(html).toContain('Value')
    expect(html).toContain('Actual cost')
    expect(html).toContain('$19.00')
    expect(html).toContain('Claude $19.00')
    expect(html).toContain('Claude —')
    expect(html).toContain('Hide cost')
  })

  it('passes the team and a known sort to the API, and drops an unknown sort', async () => {
    state.teams = [{ id: 't1', name: 'Platform' } as Team]
    const html = await render({ ...NOV, teamId: 't1', sort: 'score' })
    expect(state.asked[0]).toEqual(['2026-11-01', '2026-11-30', 'org-1', 't1', 'score'])
    expect(html).toContain('team-picker')
    expect(html).toContain('ranked by score')
    await render({ ...NOV, teamId: 'stale', sort: 'spend' })
    expect(state.asked[1]).toEqual(['2026-11-01', '2026-11-30', 'org-1', undefined, undefined])
  })

  it('shows a lone row as "of N" in rank mode', async () => {
    state.rows = [row({ rank: 3, outOf: 12 })]
    expect(await render(NOV)).toContain('of 12')
  })

  it('says so when the API fails, and when the range is empty', async () => {
    state.rows = null
    expect(await render(NOV)).toContain('Could not read the leaderboard.')
    state.rows = []
    expect(await render(NOV)).toContain('No data for this range')
  })

  it('shows the hide-my-name form with the saved choice, and leaves it out when settings fail', async () => {
    state.hidden = true
    expect(await render(NOV)).toContain('hide-form:true')
    state.hidden = null
    expect(await render(NOV)).not.toContain('hide-form')
  })
})
