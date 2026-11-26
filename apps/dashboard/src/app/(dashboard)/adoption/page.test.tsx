import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  FeatureMatrixResponse,
  FunnelCounts,
  FunnelResponse,
  UnusedSeatsResponse,
  OnboardingCounts,
  OnboardingResponse,
  PracticeGroup,
  PracticesResponse,
  Team,
  UsageDistributionResponse,
} from '@burn-watch/shared'

const state = vi.hoisted(() => ({
  role: 'admin' as string | null,
  data: null as UnusedSeatsResponse | null,
  asked: [] as number[],
  funnel: null as FunnelResponse | null,
  funnelAsked: [] as string[][],
  features: null as FeatureMatrixResponse | null,
  practices: null as PracticesResponse | null,
  onboarding: null as OnboardingResponse | null,
  rankAsked: [] as string[],
  distribution: null as UsageDistributionResponse | 'tooSmall' | null,
  distributionAsked: [] as unknown[][],
  teams: [] as Team[],
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
}))
vi.mock('@/lib/session', () => ({ getUserRole: async () => state.role }))
vi.mock('@/lib/api', () => ({
  fetchTeams: async () => state.teams,
  fetchUnusedSeats: async (idleDays: number) => {
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
  fetchOnboarding: async () => {
    if (!state.onboarding) throw new Error('down')
    return state.onboarding
  },
  fetchPractices: async (_from: string, _to: string, rankBy: string) => {
    state.rankAsked.push(rankBy)
    if (!state.practices) throw new Error('down')
    return state.practices
  },
  fetchUsageDistribution: async (...args: unknown[]) => {
    state.distributionAsked.push(args)
    if (state.distribution === 'tooSmall') throw new GroupTooSmallError('group_too_small')
    if (!state.distribution) throw new Error('down')
    return state.distribution
  },
}))
vi.mock('@/components/TeamFilter', () => ({ TeamFilter: () => null }))

const { GroupTooSmallError } = await import('@/lib/group-too-small')

const { default: AdoptionPage } = await import('./page')

const render = async (params: Record<string, string> = {}) =>
  renderToStaticMarkup(await AdoptionPage({ searchParams: Promise.resolve(params) }))

const empty = (orgSeats: number): UnusedSeatsResponse => ({
  idleDays: 14,
  rows: [],
  byAgent: [],
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
  state.onboarding = null
  state.rankAsked = []
  state.distribution = null
  state.distributionAsked = []
  state.teams = []
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

  it('says nothing is unused when seats exist, using the chosen idleDays', async () => {
    state.data = empty(3)
    const html = await render({ idleDays: '30', from: '2026-11-01' })
    expect(state.asked).toEqual([30])
    expect(html).toContain('No seats unused for 30+ days.')
    // The form keeps other params when idleDays changes.
    expect(html).toContain('name="from" value="2026-11-01"')
  })

  it('falls back to 14 days for a value the API would reject', async () => {
    await render({ idleDays: '0' })
    await render({ idleDays: 'abc' })
    expect(state.asked).toEqual([14, 14])
  })

  it('hides unused seats from a manager and never asks for them', async () => {
    state.role = 'manager'
    const html = await render()
    expect(state.asked).toEqual([])
    expect(html).not.toContain('Unused seats')
    expect(html).not.toContain('No seats entered yet.')
  })

  it('renders named rows for an admin in API order with the summary', async () => {
    state.data = {
      idleDays: 14,
      rows: [
        { userId: 'u2', userName: 'Bo', agent: 'copilot', daysUnused: 41 },
        { userId: 'u1', userName: 'Ada', agent: 'claude', daysUnused: 20 },
      ],
      byAgent: [
        { agent: 'claude', seats: 1, monthlyUsd: 30 },
        { agent: 'copilot', seats: 1, monthlyUsd: 19 },
      ],
      totalMonthlyUsd: 49,
      orgSeats: 2,
    }
    const html = await render()
    expect(html).toContain('Unused seats')
    expect(html).toContain('2 unused seats, $49.00/month')
    expect(html).toContain('41')
    expect(html.indexOf('Bo')).toBeLessThan(html.indexOf('Ada'))
  })

  it('says so when the API is down', async () => {
    state.data = null
    expect(await render()).toContain('Could not read unused seats')
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

  it('lists no people, only counts, and says teams show from 5 members', async () => {
    state.funnel = funnel()
    const html = await render()
    expect(html).not.toContain('<details')
    expect(html).toContain('Teams show from 5 members.')
  })

  it('says so when the funnel cannot be read', async () => {
    expect(await render()).toContain('Could not read the funnel.')
  })

  describe('Usage distribution', () => {
    const dist: UsageDistributionResponse = {
      from: '2026-11-01',
      to: '2026-11-30',
      people: 12,
      bands: { none: 2, '1-2': 3, '3-4': 4, '5+': 3 },
    }

    it('shows the four band counts with plain labels and the total, for the picked range', async () => {
      state.distribution = dist
      const html = await render({ from: '2026-11-01', to: '2026-11-30' })
      expect(state.distributionAsked).toEqual([['2026-11-01', '2026-11-30', undefined]])
      expect(html).toContain('How often people use an agent')
      for (const [label, n] of [['Not used', 2], ['1 to 2 days a week', 3], ['3 to 4 days a week', 4], ['5 or more days a week', 3]]) {
        expect(html).toMatch(new RegExp(`${label}</dt><dd[^>]*>${n}</dd>`))
      }
      expect(html).toContain('12 people in total.')
    })

    it('passes the picked team', async () => {
      state.teams = [{ id: 't1', name: 'Platform' } as Team]
      state.distribution = dist
      await render({ from: '2026-11-01', to: '2026-11-30', teamId: 't1' })
      expect(state.distributionAsked).toEqual([['2026-11-01', '2026-11-30', 't1']])
    })

    it('shows the group-too-small notice in the card, and keeps the rest of the page', async () => {
      state.distribution = 'tooSmall'
      const html = await render()
      expect(html).toContain('fewer than 5 people')
      expect(html).toContain('Unused seats')
    })

    it('says so when it cannot be read', async () => {
      expect(await render()).toContain('Could not read usage.')
    })
  })

    describe('Features', () => {
    const none = { mcp: 0, skills: 0, subagents: 0, plan: 0, sdk: 0 }
    const matrix = (over: Partial<FeatureMatrixResponse> = {}): FeatureMatrixResponse => ({
      from: '2026-11-16',
      to: '2026-11-22',
      total: { users: 2, used: { ...none, mcp: 2, skills: 1 }, sdkKnown: 0 },
      teams: [{ teamId: 't1', teamName: 'Platform', users: 1, used: { ...none, mcp: 1 }, sdkKnown: 1 }],
      noTeam: null,
      ...over,
    })

    it('shows the share of each group per feature, and a dash for SDK when no agent reports it', async () => {
      state.features = matrix()
      const html = await render()
      expect(html).toContain('Features')
      // Total: MCP 2 of 2, skills 1 of 2. Platform: MCP 1 of 1.
      expect(html).toMatch(/Total<\/td>(?:(?!<\/tr>).)*100%(?:(?!<\/tr>).)*50%/)
      // Total SDK: nobody known, so a dash. Platform SDK: 0 of 1.
      expect(html).toMatch(/Total<\/td>(?:(?!<\/tr>).)*—/)
      expect(html).toMatch(/Platform<\/td>(?:(?!<\/tr>).)*0%<\/td><\/tr>/)
      expect(html).not.toContain(' of 2')
    })

    it('has no per-person grid', async () => {
      state.features = matrix()
      const html = await render()
      expect(html).not.toContain('Per person')
      expect(html).not.toContain('<details')
    })

    it('says so when no one used Claude Code, and when it cannot be read', async () => {
      state.features = matrix({ total: { users: 0, used: none, sdkKnown: 0 }, teams: [] })
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
      volunteers: [],
      setup: [],
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
    })

    it('passes the picked ranking and keeps other params in the links', async () => {
      state.practices = practices({ rankBy: 'tokens' })
      const html = await render({ rankBy: 'tokens', from: '2026-11-01' })
      expect(state.rankAsked).toEqual(['tokens'])
      expect(html).toContain('href="?from=2026-11-01"')
      expect(html).toContain('Claude tokens')
      expect(html).not.toMatch(/leaderboard/i)
    })

    it('ignores an unknown ranking, including the removed score', async () => {
      await render({ rankBy: 'cost' })
      await render({ rankBy: 'score' })
      expect(state.rankAsked).toEqual(['days', 'days'])
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

    it('lists volunteers per team with what they can help with, even below the comparison minimum', async () => {
      state.practices = practices({
        top: null,
        rest: null,
        population: 3,
        volunteers: [
          {
            teamId: 't1',
            teamName: 'Platform',
            volunteers: [
              { userId: 'u1', name: 'Ada', canHelpWith: ['mcp', 'skills'] },
              { userId: 'u2', name: 'Bo', canHelpWith: [] },
            ],
          },
          { teamId: null, teamName: 'No team', volunteers: [{ userId: 'u3', name: 'Cy', canHelpWith: ['plan'] }] },
        ],
      })
      const html = await render()
      expect(html).toContain('Needs 4 or more')
      expect(html).toContain('Happy to help')
      expect(html).toContain('People who said they are happy to help with Claude Code. Anyone can add themselves on <a')
      expect(html).toContain('href="/me">My usage</a>')
      expect(html).toContain('Ada')
      expect(html).toContain('MCP, Skills')
      expect(html).toContain('Bo')
      expect(html).toContain('Plan mode')
      expect(html).not.toContain('Active days</th>')
    })

    it('says so when nobody has added themselves', async () => {
      state.practices = practices()
      expect(await render()).toContain('Nobody has added themselves yet.')
    })
  })

  describe('Recommended setup', () => {
    const base: PracticesResponse = {
      from: '2026-11-01', to: '2026-11-07', rankBy: 'days', population: 2, minPopulation: 4,
      top: null, rest: null, tips: [], volunteers: [], setup: [],
    }
    const card = {
      teamId: null,
      teamName: 'Whole org',
      groupSize: 3,
      reason: 'ok' as const,
      items: [
        { key: 'github', source: 'local' as const, topUsers: 3, teamUsers: 5, approved: true },
        { key: 'plugin_sp_x', source: 'plugin' as const, topUsers: 2, teamUsers: 2, approved: false },
        { key: 'claude_ai_Gmail', source: 'claude.ai' as const, topUsers: 2, teamUsers: 4, approved: null },
      ],
    }

    it('groups servers by source, counts them, and badges unapproved ones', async () => {
      state.practices = { ...base, setup: [card, { teamId: 't1', teamName: 'Platform', groupSize: 1, reason: 'smallGroup', items: [] }] }
      const html = await render()
      expect(html).toContain('Recommended setup')
      expect(html).toContain('Based on 3 top users')
      expect(html).toContain('Add to .mcp.json')
      expect(html).toContain('3 of 3 top, 5 in all')
      expect(html.match(/not approved/g)).toHaveLength(1)
      expect(html).toContain('Fewer than 2 top users here.')
      expect(html).toContain('aria-label="Copy checklist for Whole org"')
    })

    it('builds a plain checklist', async () => {
      const { setupChecklist } = await import('@/lib/setup')
      expect(setupChecklist(card)).toBe(
        'Recommended setup for Whole org\nAdd to .mcp.json: github\nInstall plugin: plugin_sp_x\nConnect in claude.ai: claude_ai_Gmail\nSkills: needs agent 0.6 or later',
      )
    })
  })

  describe('Onboarding', () => {
    const c = (cohort: number, onboarded: number, missed: number, inProgress = 0, noFeatureData = 0): OnboardingCounts =>
      ({ cohort, onboarded, missed, inProgress, noFeatureData })
    const onboarding = (over: Partial<OnboardingResponse> = {}): OnboardingResponse => ({
      from: '2026-11-01',
      to: '2026-11-30',
      activeDaysPerWeek: 2,
      minFeatures: 2,
      minForPercent: 5,
      total: c(4, 3, 1),
      teams: [],
      noTeam: c(4, 3, 1),
      ...over,
    })

    it('shows n of m without a percentage below 5 finished windows', async () => {
      state.onboarding = onboarding()
      const html = await render()
      expect(html).toContain('Onboarding')
      expect(html).toContain('3 of 4<')
      expect(html).not.toContain('3 of 4 (')
    })

    it('adds the percentage from 5 finished windows', async () => {
      state.onboarding = onboarding({ total: c(5, 4, 1), noTeam: null })
      expect(await render()).toContain('4 of 5 (80%)')
    })

    it('shows counts only, with neutral labels', async () => {
      state.onboarding = onboarding()
      const html = await render()
      expect(html).toContain('Window ended')
      expect(html).not.toContain('<details')
      expect(html).not.toMatch(/missed|scored/i)
    })

    it('says no counts are shown when fewer than 5 people started', async () => {
      state.onboarding = onboarding({ total: null, noTeam: null })
      const html = await render()
      expect(html).toContain('Fewer than 5 people started in this range, so no counts are shown.')
      expect(html).not.toContain('>Total<')
    })

    it('says when nobody started in range', async () => {
      state.onboarding = onboarding({ total: c(0, 0, 0), noTeam: c(0, 0, 0) })
      expect(await render()).toContain('Nobody had a first sync in this range.')
    })
  })
})
