import { Suspense } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import {
  FEATURE_KEYS,
  PRACTICE_FEATURES,
  PRACTICE_RANKS,
  type FeatureCounts,
  type FeatureKey,
  type FeatureMatrixResponse,
  type FunnelCounts,
  type FunnelResponse,
  type FunnelStop,
  type OnboardingCounts,
  type OnboardingPerson,
  type OnboardingResponse,
  type ChampionReason,
  type PracticeFeature,
  type PracticeGroup,
  type PracticeRank,
  type PracticesResponse,
  type TipId,
} from '@burn-watch/shared'
import { fetchFeatures, fetchFunnel, fetchIdleSeats, fetchOnboarding, fetchPractices, fetchTeams } from '@/lib/api'
import { agentById } from '@/lib/agents'
import { formatCost, formatRange, resolveRange } from '@/lib/format'
import { pickTeam } from '@/lib/teams'
import { getUserRole } from '@/lib/session'
import { TeamFilter } from '@/components/TeamFilter'
import { PageHeader, Section, TableFrame, Th, Td, Tr, EmptyRow, Badge, inputClass, secondaryButtonClass } from '@/components/ui'

const DEFAULT_IDLE_DAYS = 14

/** The URL value when it is a whole number of days the API accepts, else the default. */
function idleDaysFrom(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_IDLE_DAYS
}

type Params = Record<string, string | undefined>

export default async function AdoptionPage({ searchParams }: { searchParams: Promise<Params> }) {
  const role = await getUserRole()
  if (role !== 'admin' && role !== 'manager') redirect('/')

  const params = await searchParams
  const idleDays = idleDaysFrom(params.idleDays)
  const { from, to } = resolveRange(params)
  const teams = await fetchTeams().catch(() => [])
  const team = pickTeam(teams, params.teamId)
  const rankBy = PRACTICE_RANKS.find((r) => r === params.rankBy) ?? 'days'
  const [data, funnel, onboarding, features, practices] = await Promise.all([
    fetchIdleSeats(idleDays, team?.id).catch(() => null),
    fetchFunnel(from, to, team?.id).catch(() => null),
    fetchOnboarding(from, to, team?.id).catch(() => null),
    fetchFeatures(from, to, team?.id).catch(() => null),
    fetchPractices(from, to, rankBy, team?.id).catch(() => null),
  ])
  // Keep the range and team in the URL when the form changes idleDays.
  const carried = Object.entries(params).filter(([k, v]) => k !== 'idleDays' && v !== undefined)

  return (
    <div>
      <PageHeader title="Adoption" subtitle={`${formatRange(from, to)}${team ? ` · team ${team.name}` : ''}`} />

      {teams.length > 0 && (
        <Suspense fallback={null}>
          <TeamFilter teams={teams} value={team?.id} />
        </Suspense>
      )}

      <div className="space-y-6">
        <Section
          title="Idle seats"
          description="Paid seats with no tokens on their agent for the number of days below. Seats newer than that are left out. Cancel seats in Admin > Seats."
        >
          <form method="get" className="mb-4 flex items-center gap-2">
            {carried.map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <label htmlFor="idle-days" className="text-xs text-ink-2">
              Idle for at least
            </label>
            <input
              id="idle-days"
              type="number"
              name="idleDays"
              min={1}
              max={365}
              step={1}
              defaultValue={idleDays}
              className={`${inputClass} w-24`}
            />
            <span className="text-xs text-ink-2">days</span>
            <button type="submit" className={secondaryButtonClass}>
              Show
            </button>
          </form>

          {data && data.rows.length > 0 && (
            <>
              <p className="mb-1 text-sm text-ink">
                {data.rows.length} idle {data.rows.length === 1 ? 'seat' : 'seats'},{' '}
                {formatCost(data.totalMonthlyUsd)}/month
              </p>
              <p className="mb-3 text-sm text-ink-2">
                {data.byAgent
                  .map((a) => `${agentById(a.agent)?.label ?? a.agent}: ${a.seats}, ${formatCost(a.monthlyUsd)}/month`)
                  .join(' · ')}
              </p>
            </>
          )}

          <TableFrame>
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Person</Th>
                  <Th>Teams</Th>
                  <Th>Agent</Th>
                  <Th numeric>Last used</Th>
                  <Th numeric>Days idle</Th>
                  <Th numeric>$/month</Th>
                  <Th numeric>Cost since last use</Th>
                </tr>
              </thead>
              <tbody>
                {data === null ? (
                  <EmptyRow colSpan={7}>Could not read idle seats. Try again in a moment.</EmptyRow>
                ) : data.rows.length > 0 ? (
                  data.rows.map((r) => (
                    <Tr key={`${r.userId}:${r.agent}`}>
                      <Td className="font-medium text-ink">{r.userName ?? 'Removed user'}</Td>
                      <Td className="text-ink-2">{r.teams.length ? r.teams.join(', ') : '—'}</Td>
                      <Td>{agentById(r.agent)?.label ?? r.agent}</Td>
                      <Td numeric>{r.lastUsed ?? <Badge tone="warn">never</Badge>}</Td>
                      <Td numeric>{r.daysIdle}</Td>
                      <Td numeric>{formatCost(r.monthlyPriceUsd)}</Td>
                      <Td numeric>{formatCost(r.costSinceUsedUsd)}</Td>
                    </Tr>
                  ))
                ) : data.orgSeats === 0 ? (
                  <EmptyRow colSpan={7}>
                    No seats entered yet. Add them in{' '}
                    <Link href="/admin" className="text-brand underline-offset-4 hover:underline">
                      Admin &gt; Seats
                    </Link>
                    .
                  </EmptyRow>
                ) : (
                  <EmptyRow colSpan={7}>No seats idle for {idleDays}+ days.</EmptyRow>
                )}
              </tbody>
            </table>
          </TableFrame>
        </Section>

        <FunnelSection data={funnel} />

        <OnboardingSection data={onboarding} />

        <FeaturesSection data={features} />

        <PracticesSection data={practices} rankBy={rankBy} params={params} />
      </div>
    </div>
  )
}

const STAGES: { key: keyof FunnelCounts; label: string }[] = [
  { key: 'invited', label: 'Invited' },
  { key: 'registered', label: 'Registered' },
  { key: 'firstSync', label: 'First sync' },
  { key: 'active', label: 'Active' },
  { key: 'powerUser', label: 'Power user' },
]

const STOPS: { key: FunnelStop; label: string }[] = [
  { key: 'invited', label: 'Invited, not registered' },
  { key: 'registered', label: 'Registered, no first sync' },
  { key: 'firstSync', label: 'Synced, not active in range' },
  { key: 'active', label: 'Active, not power user' },
]

/** Share of the previous stage, or a dash when nobody reached it. */
const pctOf = (n: number, prev: number) => (prev === 0 ? '—' : `${Math.round((n / prev) * 100)}%`)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function FunnelRow({ name, c, bars = false }: { name: string; c: FunnelCounts; bars?: boolean }) {
  return (
    <Tr>
      <Td className="font-medium text-ink">{name}</Td>
      {STAGES.map((s, i) => (
        <Td key={s.key} numeric>
          {c[s.key]}
          {i > 0 && <span className="ml-1.5 text-xs text-ink-3">{pctOf(c[s.key], c[STAGES[i - 1].key])}</span>}
          {s.key === 'firstSync' && <div className="text-xs text-ink-3">{c.deviceLinked} linked a device</div>}
          {bars && (
            <div className="mt-1.5 h-1.5 rounded-full bg-surface-3">
              <div
                className="h-full rounded-full bg-brand"
                style={{ width: `${c.invited ? (c[s.key] / c.invited) * 100 : 0}%` }}
              />
            </div>
          )}
        </Td>
      ))}
    </Tr>
  )
}

function FunnelSection({ data }: { data: FunnelResponse | null }) {
  return (
    <Section
      title="Funnel"
      description="How many people reached each step in this date range. Invited counts registered users plus unused invites. Each person counts once in the total, and in every team they belong to."
    >
      <TableFrame>
        <table className="w-full">
          <thead>
            <tr>
              <Th>Team</Th>
              {STAGES.map((s) => (
                <Th key={s.key} numeric>
                  {s.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <EmptyRow colSpan={6}>Could not read the funnel. Try again in a moment.</EmptyRow>
            ) : (
              <>
                <FunnelRow name="Total" c={data.total} bars />
                {data.noTeam && data.teams.length === 0 && (
                  <EmptyRow colSpan={6}>
                    No teams yet. Create them in{' '}
                    <Link href="/admin" className="text-brand underline-offset-4 hover:underline">
                      Admin &gt; Teams
                    </Link>
                    .
                  </EmptyRow>
                )}
                {data.teams.map((t) => (
                  <FunnelRow key={t.teamId} name={t.teamName} c={t} />
                ))}
                {data.noTeam && <FunnelRow name="No team" c={data.noTeam} />}
              </>
            )}
          </tbody>
        </table>
      </TableFrame>

      {data && (
        <>
          <p className="mt-3 text-xs text-ink-2">
            Active: tokens on {plural(data.activeDays, 'day')} or more. Power user: tokens on {data.powerDays} or more of{' '}
            {plural(data.rangeDays, 'day')} since {data.from}.
          </p>
          {data.stuck.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-ink">
                Who is stuck ({data.stuck.length})
              </summary>
              {STOPS.map((stop) => {
                const people = data.stuck.filter((p) => p.stoppedAt === stop.key)
                if (people.length === 0) return null
                return (
                  <div key={stop.key} className="mt-3">
                    <h3 className="text-xs font-medium tracking-wide text-ink-2 uppercase">
                      {stop.label} ({people.length})
                    </h3>
                    <ul className="mt-1 space-y-1 text-sm">
                      {people.map((p) => (
                        <li key={p.userId ?? p.email} className="flex flex-wrap gap-x-3">
                          <span className="text-ink">{p.name ?? p.email}</span>
                          <span className="text-ink-2">{p.teams.length ? p.teams.join(', ') : 'No team'}</span>
                          <span className="tabular-nums text-ink-3">{p.lastStepDate}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </details>
          )}
        </>
      )}
    </Section>
  )
}

/** "n of m" for people whose window is over, with a % from `min` finished windows (D6 Decision 5). */
function onboardedOf(c: OnboardingCounts, min: number) {
  const done = c.onboarded + c.missed
  if (done === 0) return '—'
  return `${c.onboarded} of ${done}${done >= min ? ` (${Math.round((c.onboarded / done) * 100)}%)` : ''}`
}

/** What a person still lacks, in plain words. */
function missing(p: OnboardingPerson, d: OnboardingResponse) {
  const gaps: string[] = []
  if (p.activeWeek1 < d.activeDaysPerWeek) gaps.push(`week 1: ${p.activeWeek1} of ${d.activeDaysPerWeek} days`)
  if (p.activeWeek2 < d.activeDaysPerWeek) gaps.push(`week 2: ${p.activeWeek2} of ${d.activeDaysPerWeek} days`)
  if (p.features.length < d.minFeatures) gaps.push(`features: ${p.features.length} of ${d.minFeatures}`)
  return gaps.join(' · ')
}

function OnboardingRow({ name, c, min }: { name: string; c: OnboardingCounts; min: number }) {
  return (
    <Tr>
      <Td className="font-medium text-ink">{name}</Td>
      <Td numeric>{c.cohort}</Td>
      <Td numeric>{onboardedOf(c, min)}</Td>
      <Td numeric>{c.missed}</Td>
      <Td numeric>{c.inProgress}</Td>
      <Td numeric>{c.noFeatureData}</Td>
    </Tr>
  )
}

function OnboardingSection({ data }: { data: OnboardingResponse | null }) {
  const teamName = new Map(data?.teams.map((t) => [t.teamId, t.teamName]))
  const teamsOf = (p: OnboardingPerson) => (p.teamIds.length ? p.teamIds.map((id) => teamName.get(id) ?? id).join(', ') : 'No team')
  const lists = data
    ? [
        { key: 'inProgress', label: 'In progress', when: (p: OnboardingPerson) => `day ${p.dayOfWindow} of 14` },
        { key: 'missed', label: 'Missed', when: (p: OnboardingPerson) => `first sync ${p.firstSync}` },
      ].map((l) => ({ ...l, people: data.people.filter((p) => p.state === l.key) }))
    : []
  return (
    <Section
      title="Onboarding"
      description="People whose first sync is in this range. Onboarded: tokens on 2 or more days in each of their first two weeks, and 2 or more Claude Code features in their first 14 days. No feature data: no Claude Code use in those 14 days, so they are not scored."
    >
      <TableFrame>
        <table className="w-full">
          <thead>
            <tr>
              <Th>Team</Th>
              <Th numeric>New</Th>
              <Th numeric>Onboarded</Th>
              <Th numeric>Missed</Th>
              <Th numeric>In progress</Th>
              <Th numeric>No feature data</Th>
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <EmptyRow colSpan={6}>Could not read onboarding. Try again in a moment.</EmptyRow>
            ) : data.total.cohort === 0 ? (
              <EmptyRow colSpan={6}>Nobody had a first sync in this range.</EmptyRow>
            ) : (
              <>
                <OnboardingRow name="Total" c={data.total} min={data.minForPercent} />
                {data.teams.map((t) => (
                  <OnboardingRow key={t.teamId} name={t.teamName} c={t} min={data.minForPercent} />
                ))}
                {data.noTeam && <OnboardingRow name="No team" c={data.noTeam} min={data.minForPercent} />}
              </>
            )}
          </tbody>
        </table>
      </TableFrame>
      {data && (
        <p className="mt-3 text-xs text-ink-2">
          Onboarded counts people whose 14 days are over. A percentage shows from {data.minForPercent} of them.
        </p>
      )}
      {lists.map(
        (l) =>
          l.people.length > 0 && (
            <details key={l.key} className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-ink">
                {l.label} ({l.people.length})
              </summary>
              <ul className="mt-2 space-y-1 text-sm">
                {l.people.map((p) => (
                  <li key={p.userId} className="flex flex-wrap gap-x-3">
                    <span className="text-ink">{p.name}</span>
                    <span className="text-ink-2">{teamsOf(p)}</span>
                    <span className="tabular-nums text-ink-3">{l.when(p)}</span>
                    <span className="text-ink-2">{missing(p, data!)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ),
      )}
    </Section>
  )
}

const FEATURES: Record<FeatureKey, string> = {
  mcp: 'MCP',
  skills: 'Skills',
  subagents: 'Subagents',
  plan: 'Plan mode',
  sdk: 'SDK',
}

/** "n of m" for a feature; SDK counts only people whose agent reports it. */
function usedOf(c: FeatureCounts, key: FeatureKey) {
  const of = key === 'sdk' ? c.sdkKnown : c.users
  return of === 0 ? '—' : `${c.used[key]} of ${of}`
}

function FeatureRow({ name, c }: { name: string; c: FeatureCounts }) {
  return (
    <Tr>
      <Td className="font-medium text-ink">{name}</Td>
      <Td numeric>{c.users}</Td>
      {FEATURE_KEYS.map((k) => (
        <Td key={k} numeric>
          {usedOf(c, k)}
        </Td>
      ))}
    </Tr>
  )
}

function FeaturesSection({ data }: { data: FeatureMatrixResponse | null }) {
  const teamName = new Map(data?.teams.map((t) => [t.teamId, t.teamName]))
  return (
    <Section
      title="Features"
      description="Claude Code users who used each feature on at least one day in this range. Claude Code only. SDK needs agent 0.4 or later, so it counts only people whose agent reports it."
    >
      <TableFrame>
        <table className="w-full">
          <thead>
            <tr>
              <Th>Team</Th>
              <Th numeric>Users</Th>
              {FEATURE_KEYS.map((k) => (
                <Th key={k} numeric>
                  {FEATURES[k]}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <EmptyRow colSpan={7}>Could not read feature use. Try again in a moment.</EmptyRow>
            ) : data.total.users === 0 ? (
              <EmptyRow colSpan={7}>No Claude Code use in this range.</EmptyRow>
            ) : (
              <>
                <FeatureRow name="Total" c={data.total} />
                {data.teams.map((t) => (
                  <FeatureRow key={t.teamId} name={t.teamName} c={t} />
                ))}
                {data.noTeam && <FeatureRow name="No team" c={data.noTeam} />}
              </>
            )}
          </tbody>
        </table>
      </TableFrame>

      {data && data.people.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-ink">
            Per person ({data.people.length})
          </summary>
          <TableFrame>
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Team</Th>
                  <Th numeric>Active days</Th>
                  {FEATURE_KEYS.map((k) => (
                    <Th key={k} numeric>
                      {FEATURES[k]}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <Tr key={p.userId}>
                    <Td className="text-ink">{p.name}</Td>
                    <Td className="text-ink-2">
                      {p.teamIds.length ? p.teamIds.map((id) => teamName.get(id) ?? id).join(', ') : 'No team'}
                    </Td>
                    <Td numeric>{p.activeDays}</Td>
                    {FEATURE_KEYS.map((k) => (
                      <Td key={k} numeric>
                        {p.days[k] ? plural(p.days[k], 'day') : '—'}
                      </Td>
                    ))}
                  </Tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        </details>
      )}
    </Section>
  )
}

const RANK_LABELS: Record<PracticeRank, string> = { days: 'Active days', tokens: 'Claude tokens', score: 'Leaderboard score' }

/** A6 Decision 4: fixed text per rule. */
const TIPS: Record<TipId, string> = {
  mcp: 'Most top users call MCP servers; most others do not. See which servers they use under Governance > MCP and add the useful ones to the team setup.',
  skills: "Top users run skills. Share the team's skills in the repo's .claude/skills/ folder.",
  subagents: 'Top users hand work to subagents. Try asking Claude to split a large search or review across subagents.',
  plan: 'Top users plan before they edit. Try plan mode (Shift+Tab) for changes that touch several files.',
  cache: 'Others get fewer cache hits. Keep long tasks in one session and switch models less mid-session, so more cached context is reused.',
}

const USES: Record<PracticeFeature, string> = {
  mcp: 'Uses MCP',
  skills: 'Uses skills',
  subagents: 'Uses subagents',
  plan: 'Uses plan mode',
}

const pct = (n: number) => `${Math.round(n * 100)}%`

function PracticesSection({ data, rankBy, params }: { data: PracticesResponse | null; rankBy: PracticeRank; params: Params }) {
  const href = (r: PracticeRank) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries({ ...params, rankBy: r === 'days' ? undefined : r })) if (v !== undefined) q.set(k, v)
    return `?${q}`
  }
  const rows: { label: string; value: (g: PracticeGroup) => string }[] = [
    ...PRACTICE_FEATURES.map((k) => ({ label: USES[k], value: (g: PracticeGroup) => pct(g.uses[k]) })),
    { label: 'MCP servers (median)', value: (g) => String(g.mcpServers) },
    { label: 'Cache hit rate (median)', value: (g) => (g.cacheHitRate === null ? '—' : `${g.cacheHitRate.toFixed(1)}%`) },
  ]
  return (
    <Section
      title="Top users vs rest"
      description="The top quarter of Claude Code users, ranked by the measure below, compared with everyone else. Claude Code only. No names."
    >
      <p className="mb-3 flex flex-wrap gap-x-3 text-xs text-ink-2">
        Rank by:
        {PRACTICE_RANKS.map((r) => (
          <Link
            key={r}
            href={href(r)}
            aria-current={r === rankBy ? 'true' : undefined}
            className={r === rankBy ? 'font-medium text-ink' : 'text-brand underline-offset-4 hover:underline'}
          >
            {RANK_LABELS[r]}
          </Link>
        ))}
      </p>
      {rankBy === 'score' && (
        <p className="mb-3 text-xs text-ink-2">
          The leaderboard score counts MCP servers tried, so the MCP rows partly compare the score with itself.
        </p>
      )}
      {data === null ? (
        <p className="text-sm text-ink-2">Could not read the comparison. Try again in a moment.</p>
      ) : !data.top || !data.rest ? (
        <p className="text-sm text-ink-2">
          Needs {data.minPopulation} or more Claude Code users in range. This scope has {data.population}.
        </p>
      ) : (
        <>
          <TableFrame>
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Measure</Th>
                  <Th numeric>Top ({data.top.users})</Th>
                  <Th numeric>Rest ({data.rest.users})</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Tr key={row.label}>
                    <Td className="text-ink">{row.label}</Td>
                    <Td numeric>{row.value(data.top!)}</Td>
                    <Td numeric>{row.value(data.rest!)}</Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
          {data.tips.length > 0 && (
            <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-ink">
              {data.tips.map((t) => (
                <li key={t.id}>{TIPS[t.id]}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {data && <Champions data={data} />}
    </Section>
  )
}

const REASONS: Record<Exclude<ChampionReason, 'ok'>, string> = {
  tooFew: 'Too few users to suggest',
  noneEligible: 'No one to suggest',
}

const featureList = (keys: PracticeFeature[]) => (keys.length ? keys.map((k) => FEATURES[k]).join(', ') : '—')

/** R2 A7. A hint only: nothing is stored and nobody is told. */
function Champions({ data }: { data: PracticesResponse }) {
  if (!data.namesOff && data.champions.length === 0) return null
  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium text-ink">Suggested champions</h3>
      <p className="mt-1 mb-3 text-xs text-ink-2">
        The top 2 per team by {RANK_LABELS[data.rankBy].toLowerCase()}. Teams need 3 or more Claude Code users. A
        suggestion only; nobody is told.
      </p>
      {data.namesOff ? (
        <p className="text-sm text-ink-2">Names are off for this org.</p>
      ) : (
        <TableFrame>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Team</Th>
                <Th>Champion</Th>
                <Th numeric>Active days</Th>
                <Th>Uses</Th>
                <Th>Can help with</Th>
              </tr>
            </thead>
            <tbody>
              {data.champions.flatMap((team) =>
                team.reason !== 'ok'
                  ? [
                      <Tr key={team.teamId ?? 'none'}>
                        <Td className="font-medium text-ink">{team.teamName}</Td>
                        <Td className="text-ink-3">
                          {REASONS[team.reason]} ({plural(team.users, 'user')})
                        </Td>
                        <Td numeric>{''}</Td>
                        <Td>{''}</Td>
                        <Td>{''}</Td>
                      </Tr>,
                    ]
                  : team.champions.map((c, i) => (
                      <Tr key={`${team.teamId ?? 'none'}:${c.userId}`}>
                        <Td className="font-medium text-ink">{i === 0 ? team.teamName : ''}</Td>
                        <Td className="text-ink">
                          {c.name}
                          {c.hidden && <span className="ml-2 text-xs text-ink-3">Hidden from leaderboard</span>}
                        </Td>
                        <Td numeric>{c.activeDays}</Td>
                        <Td className="text-ink-2">{featureList(c.uses)}</Td>
                        <Td className="text-ink-2">{featureList(c.canHelpWith)}</Td>
                      </Tr>
                    )),
              )}
            </tbody>
          </table>
        </TableFrame>
      )}
    </div>
  )
}
