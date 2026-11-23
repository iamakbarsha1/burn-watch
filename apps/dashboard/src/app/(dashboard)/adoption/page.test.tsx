import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FeatureMatrixResponse, FunnelCounts, FunnelResponse, IdleSeatsResponse, PracticeGroup, PracticesResponse } from '@burn-watch/shared'

const state = vi.hoisted(() => ({
  role: 'admin' as string | null,
  data: null as IdleSeatsResponse | null,
  asked: [] as number[],
  funnel: null as FunnelResponse | null,
  funnelAsked: [] as string[][],
  features: null as FeatureMatrixResponse | null,
  practices: null as PracticesResponse | null,
  rankAsked: [] as string[],
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
  fetchFunnel: async (from: string, to: string) => {
    state.funnelAsked.push([from, to])
    if (!state.funnel) throw new Error('down')
    return state.funnel
  },
  fetchFeatures: async () => {
    if (!state.features) throw new Error('down')
    return state.features
  },
  fetchPractices: async (_from: string, _to: string, rankBy: string) => {
    state.rankAsked.push(rankBy)
    if (!state.practices) throw new Error('down')
    return state.practices
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
  state.funnel = null
  state.funnelAsked = []
  state.features = null
  state.practices = null
  state.rankAsked = []
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

const counts = (invited: number, registered: number, deviceLinked: number, firstSync: number, active: number, powerUser: number): FunnelCounts =>
  ({ invited, registered, deviceLinked, firstSync, active, powerUser })

const funnel = (over: Partial<FunnelResponse> = {}): FunnelResponse => ({
  from: '2026-11-16',
  to: '2026-11-22',
  rangeDays: 7,
  activeDays: 2,
  powerDays: 5,
  total: counts(6, 6, 4, 2, 2, 1),
  teams: [],
  noTeam: counts(6, 6, 4, 2, 2, 1),
  stuck: [],
  ...over,
})

describe('AdoptionPage funnel', () => {
  it('asks for the page range and shows the total row, thresholds and the no-teams note', async () => {
    state.funnel = funnel()
    const html = await render({ from: '2026-11-16', to: '2026-11-22' })
    expect(state.funnelAsked).toEqual([['2026-11-16', '2026-11-22']])
    expect(html).toContain('Total')
    expect(html).toContain('4 linked a device')
    // First sync is 2 of 6 registered, power user 1 of 2 active.
    expect(html).toContain('33%')
    expect(html).toContain('50%')
    expect(html).toContain('Active: tokens on 2 days or more. Power user: tokens on 5 or more of 7 days since 2026-11-16.')
    expect(html).toContain('No teams yet. Create them in')
    expect(html).toContain('No team')
    // The total row comes before the No team row.
    expect(html.indexOf('Total')).toBeLessThan(html.indexOf('>No team<'))
  })

  it('shows a dash when the previous stage is zero', async () => {
    state.funnel = funnel({ total: counts(2, 0, 0, 0, 0, 0), noTeam: null })
    const html = await render()
    expect(html).toContain('—')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('Infinity')
  })

  it('lists teams after the total, with no no-teams note and no No team row for a manager', async () => {
    state.role = 'manager'
    state.funnel = funnel({
      teams: [{ teamId: 't1', teamName: 'Platform', ...counts(3, 2, 1, 1, 0, 0) }],
      noTeam: null,
    })
    const html = await render()
    expect(html).toContain('Platform')
    expect(html).not.toContain('No teams yet')
    expect(html).not.toContain('>No team<')
  })

  it('groups who is stuck by stopping point in a collapsed list', async () => {
    state.funnel = funnel({
      stuck: [
        { stoppedAt: 'invited', userId: null, name: null, email: 'new@x.io', teams: [], lastStepDate: '2026-11-01' },
        { stoppedAt: 'firstSync', userId: 'u3', name: 'Cy', email: null, teams: ['Platform'], lastStepDate: '2026-11-19' },
      ],
    })
    const html = await render()
    expect(html).toContain('<details')
    expect(html).not.toContain('<details open')
    expect(html).toContain('Who is stuck (2)')
    expect(html).toContain('Invited, not registered (1)')
    expect(html).toContain('Synced, not active in range (1)')
    expect(html).not.toContain('Registered, no first sync')
    expect(html.indexOf('new@x.io')).toBeLessThan(html.indexOf('Cy'))
  })

  it('says so when the funnel cannot be read', async () => {
    expect(await render()).toContain('Could not read the funnel.')
  })

  describe('Features', () => {
    const none = { mcp: 0, skills: 0, subagents: 0, plan: 0, sdk: 0 }
    const matrix = (over: Partial<FeatureMatrixResponse> = {}): FeatureMatrixResponse => ({
      from: '2026-11-16',
      to: '2026-11-22',
      total: { users: 2, used: { ...none, mcp: 2, skills: 1 }, sdkKnown: 0 },
      teams: [{ teamId: 't1', teamName: 'Platform', users: 1, used: { ...none, mcp: 1 }, sdkKnown: 1 }],
      noTeam: null,
      people: [
        { userId: 'u1', name: 'Ada', teamIds: ['t1'], activeDays: 3, days: { mcp: 3, skills: 1, subagents: 0, plan: 0, sdk: 0 } },
        { userId: 'u2', name: 'Hidden', teamIds: [], activeDays: 1, days: { mcp: 1, skills: 0, subagents: 0, plan: 0, sdk: null } },
      ],
      ...over,
    })

    it('shows n of m per feature, and a dash for SDK when no agent reports it', async () => {
      state.features = matrix()
      const html = await render()
      expect(html).toContain('Features')
      expect(html).toContain('2 of 2')
      expect(html).toContain('1 of 2')
      // Total SDK: nobody known, so a dash. Platform SDK: 0 of 1.
      expect(html).toMatch(/Total<\/td>(?:(?!<\/tr>).)*—/)
      expect(html).toContain('0 of 1')
    })

    it('lists people with day counts, team names and hidden names', async () => {
      state.features = matrix()
      const html = await render()
      expect(html).toContain('Per person (2)')
      expect(html).toContain('3 days')
      expect(html).toContain('Platform')
      expect(html).toContain('Hidden')
      expect(html).toContain('No team')
    })

    it('says so when no one used Claude Code, and when it cannot be read', async () => {
      state.features = matrix({ total: { users: 0, used: none, sdkKnown: 0 }, teams: [], people: [] })
      expect(await render()).toContain('No Claude Code use in this range.')
      state.features = null
      expect(await render()).toContain('Could not read feature use.')
    })
  })

  describe('Top users vs rest', () => {
    const group = (over: Partial<PracticeGroup> = {}): PracticeGroup => ({
      users: 1,
      uses: { mcp: 1, skills: 0, subagents: 0, plan: 0 },
      dayShare: { mcp: 1, skills: 0, subagents: 0, plan: 0 },
      mcpServers: 2,
      cacheHitRate: 95,
      ...over,
    })
    const practices = (over: Partial<PracticesResponse> = {}): PracticesResponse => ({
      from: '2026-11-01',
      to: '2026-11-07',
      rankBy: 'days',
      population: 4,
      minPopulation: 4,
      top: group(),
      rest: group({ users: 3, uses: { mcp: 0, skills: 0, subagents: 0, plan: 0 }, mcpServers: 0, cacheHitRate: null }),
      tips: [{ id: 'mcp', gap: 1 }],
      champions: [],
      namesOff: false,
      ...over,
    })

    it('shows the table and the tips, ranked by active days by default', async () => {
      state.practices = practices()
      const html = await render()
      expect(state.rankAsked).toEqual(['days'])
      expect(html).toContain('Top users vs rest')
      expect(html).toContain('Top (1)')
      expect(html).toContain('Rest (3)')
      expect(html).toContain('95.0%')
      expect(html).toContain('Most top users call MCP servers')
      expect(html).not.toContain('compare the score with itself')
    })

    it('passes the picked ranking, keeps other params in the links, and warns on score', async () => {
      state.practices = practices({ rankBy: 'score' })
      const html = await render({ rankBy: 'score', from: '2026-11-01' })
      expect(state.rankAsked).toEqual(['score'])
      expect(html).toContain('href="?rankBy=tokens&amp;from=2026-11-01"')
      expect(html).toContain('href="?from=2026-11-01"')
      expect(html).toContain('compare the score with itself')
    })

    it('ignores an unknown ranking', async () => {
      await render({ rankBy: 'cost' })
      expect(state.rankAsked).toEqual(['days'])
    })

    it('says how many people the scope has below the minimum', async () => {
      state.practices = practices({ population: 2, top: null, rest: null, tips: [] })
      const html = await render()
      expect(html).toContain('Needs 4 or more Claude Code users in range. This scope has 2.')
      expect(html).not.toContain('Top (')
    })

    it('says when the comparison could not be read', async () => {
      expect(await render()).toContain('Could not read the comparison.')
    })

    it('lists champions per team, the hidden note, and reasons for teams without one', async () => {
      state.practices = practices({
        top: null,
        rest: null,
        population: 3,
        champions: [
          {
            teamId: 't1',
            teamName: 'Platform',
            users: 3,
            reason: 'ok',
            champions: [
              { userId: 'u1', name: 'Ada', activeDays: 18, hidden: false, uses: ['mcp', 'skills'], canHelpWith: ['skills'] },
              { userId: 'u2', name: 'Bo', activeDays: 9, hidden: true, uses: [], canHelpWith: [] },
            ],
          },
          { teamId: null, teamName: 'No team', users: 2, reason: 'tooFew', champions: [] },
        ],
      })
      const html = await render()
      // Shown even below the A6 minimum.
      expect(html).toContain('Needs 4 or more')
      expect(html).toContain('Suggested champions')
      expect(html).toContain('The top 2 per team by active days.')
      expect(html).toContain('Ada')
      expect(html).toContain('MCP, Skills')
      expect(html).toContain('Hidden from leaderboard')
      expect(html).toContain('Too few users to suggest (2 users)')
    })

    it('says names are off instead of listing champions', async () => {
      state.practices = practices({ namesOff: true })
      const html = await render()
      expect(html).toContain('Names are off for this org.')
      expect(html).not.toContain('<th scope="col" class="px-4 py-3 text-xs font-medium tracking-wide text-ink-2 uppercase whitespace-nowrap text-left">Champion</th>')
    })

    it('shows no champions block when there are no teams to show', async () => {
      state.practices = practices()
      expect(await render()).not.toContain('Suggested champions')
    })
  })
})
