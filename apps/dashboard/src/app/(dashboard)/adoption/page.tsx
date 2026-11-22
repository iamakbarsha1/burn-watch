import { Suspense } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { FunnelCounts, FunnelResponse, FunnelStop } from '@burn-watch/shared'
import { fetchFunnel, fetchIdleSeats, fetchTeams } from '@/lib/api'
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
  const [data, funnel] = await Promise.all([
    fetchIdleSeats(idleDays, team?.id).catch(() => null),
    fetchFunnel(from, to, team?.id).catch(() => null),
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
            {plural(data.rangeDays, 'day')}.
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
