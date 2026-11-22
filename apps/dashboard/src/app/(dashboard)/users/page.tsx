import { Suspense } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { LeaderboardEntry, LeaderboardSort } from '@burn-watch/shared'
import { fetchLeaderboard, fetchTeams } from '@/lib/api'
import { formatCost, formatTokens, formatRange, resolveRange, formatCount, formatMultiple } from '@/lib/format'
import { DAY_MS, agentById, toUtc } from '@/lib/agents'
import { pickTeam } from '@/lib/teams'
import { getOrgId } from '@/lib/session'
import { TeamFilter } from '@/components/TeamFilter'
import { PageHeader, TableFrame, Th, Td, Tr, EmptyRow } from '@/components/ui'

type Params = Record<string, string | undefined>

const SORT_LABELS: Record<LeaderboardSort, string> = {
  activeDays: 'active days',
  score: 'score',
  streak: 'current streak',
  tokens: 'tokens',
  cost: 'value',
}
const linkClass =
  'rounded text-brand underline-offset-4 transition-colors outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/50'

/** The current URL with some params changed; undefined removes one. */
function hrefWith(params: Params, over: Params): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...params, ...over })) if (v !== undefined) q.set(k, v)
  const query = q.toString()
  return query ? `/users?${query}` : '/users'
}

/** "$1.20", or a dash where the API withheld the figure. */
const cost = (usd: number | null) => (usd === null ? '—' : formatCost(usd))

/** A count with the names on hover, or a dash for none. */
function Tried({ names }: { names: string[] }) {
  if (names.length === 0) return <span className="text-ink-3">—</span>
  return <span title={names.join(', ')}>{names.length}</span>
}

export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const { from, to } = resolveRange(params)
  const showCost = params.cost === '1'
  const sort = Object.keys(SORT_LABELS).find((s) => s === params.sort) as LeaderboardSort | undefined

  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  const teams = await fetchTeams().catch(() => [])
  const team = pickTeam(teams, params.teamId)
  const users = await fetchLeaderboard(from, to, orgId, team?.id, sort).catch(() => null)
  const rangeDays = Math.round((toUtc(to) - toUtc(from)) / DAY_MS) + 1
  const columns = showCost ? 12 : 9

  // A sortable header: a link that sets ?sort, marked when it is the current one.
  const sortBy = (key: LeaderboardSort, label: string) => {
    const active = (sort ?? 'activeDays') === key
    return (
      <Link
        href={hrefWith(params, { sort: key === 'activeDays' ? undefined : key })}
        aria-current={active ? 'true' : undefined}
        className={active ? 'text-ink' : 'hover:text-ink'}
      >
        {label}
        {active ? ' ↓' : ''}
      </Link>
    )
  }

  return (
    <div>
      <PageHeader
        title="Leaderboard"
        subtitle={
          <>
            {formatRange(from, to)}
            {team ? ` · team ${team.name}` : ''} · ranked by {SORT_LABELS[sort ?? 'activeDays']}
            {' · '}
            <Link href={hrefWith(params, { cost: showCost ? undefined : '1' })} className={linkClass}>
              {showCost ? 'Hide cost' : 'Show cost'}
            </Link>
          </>
        }
      />

      {teams.length > 0 && (
        <Suspense fallback={null}>
          <TeamFilter teams={teams} value={team?.id} />
        </Suspense>
      )}

      <TableFrame>
        <table className="w-full border-collapse">
          <thead className="bg-surface-2">
            <tr>
              <Th>#</Th>
              <Th>Developer</Th>
              <Th numeric>{sortBy('activeDays', 'Active days')}</Th>
              <Th numeric>{sortBy('score', 'Score')}</Th>
              <Th numeric>{sortBy('streak', 'Streak')}</Th>
              <Th numeric>Agents</Th>
              <Th numeric>MCP servers</Th>
              <Th numeric>{sortBy('tokens', 'Tokens')}</Th>
              <Th numeric>Sessions</Th>
              {showCost && (
                <>
                  <Th numeric>{sortBy('cost', 'Value')}</Th>
                  <Th numeric>Actual cost</Th>
                  <Th numeric>Multiple</Th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {users === null && <EmptyRow colSpan={columns}>Could not read the leaderboard.</EmptyRow>}
            {users?.length === 0 && <EmptyRow colSpan={columns}>No data for this range</EmptyRow>}
            {users?.map((u) => (
              <Tr key={u.userId}>
                <Td className="text-ink-3">
                  {u.rank}
                  {users.length === 1 && u.outOf > 1 && <div className="text-xs">of {u.outOf}</div>}
                </Td>
                <Td>
                  <div className="font-medium text-ink">{u.name}</div>
                  {u.email && <div className="text-xs text-ink-3">{u.email}</div>}
                </Td>
                <Td numeric className="font-medium text-ink">
                  {u.activeDays} of {rangeDays}
                </Td>
                <Td numeric className="text-ink-2">
                  {u.score}
                </Td>
                <Td numeric className="text-ink">
                  {u.streak.current}
                  <div className="text-xs text-ink-3">best {u.streak.longest}</div>
                </Td>
                <Td numeric className="text-ink-2">
                  <Tried names={u.features.agents.map((a) => agentById(a)?.label ?? a)} />
                </Td>
                <Td numeric className="text-ink-2">
                  <Tried names={u.features.mcpServers} />
                </Td>
                <Td numeric className="text-ink-2">
                  {formatTokens(u.totalTokens)}
                  {showCost && <AgentCosts entry={u} />}
                </Td>
                <Td numeric className="text-ink-2">
                  {formatCount(u.sessions)}
                </Td>
                {showCost && (
                  <>
                    <Td numeric className="font-semibold text-ink">
                      {cost(u.totalCostUsd)}
                    </Td>
                    <Td numeric className="text-ink">
                      {cost(u.actualCostUsd)}
                      {u.apiSpendUsd !== null && u.apiSpendUsd > 0 && (
                        <div className="text-xs text-ink-3">{formatCost(u.apiSpendUsd)} API</div>
                      )}
                    </Td>
                    <Td numeric className="text-ink-2">
                      {formatMultiple(u.valueMultiple)}
                    </Td>
                  </>
                )}
              </Tr>
            ))}
          </tbody>
        </table>
      </TableFrame>

      {/* Weights match SCORE_WEIGHTS in apps/api/src/routes/dashboard/leaderboard.ts. */}
      <p className="mt-3 text-xs text-ink-2">
        Active day = any tokens that day (UTC). Weekends do not break a streak. Today and yesterday may not be
        synced yet. Score = 40% active days, 30% current streak, 20% tokens, 10% agents and MCP servers tried,
        each against the top person in this list.
      </p>
    </div>
  )
}

/** Per-agent value under the token figure, for agents with usage. A dash where cost is withheld. */
function AgentCosts({ entry }: { entry: LeaderboardEntry }) {
  const used = (['claude', 'qwen', 'gemini', 'codex', 'copilot'] as const).filter((a) => entry[a].tokens > 0)
  if (used.length === 0) return null
  return (
    <div className="text-xs text-ink-3">
      {used.map((a) => `${agentById(a)?.label ?? a} ${cost(entry[a].costUsd)}`).join(' · ')}
    </div>
  )
}
