import { Suspense } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { fetchIdleSeats, fetchTeams } from '@/lib/api'
import { agentById } from '@/lib/agents'
import { formatCost } from '@/lib/format'
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
  const teams = await fetchTeams().catch(() => [])
  const team = pickTeam(teams, params.teamId)
  const data = await fetchIdleSeats(idleDays, team?.id).catch(() => null)
  // Keep the range and team in the URL when the form changes idleDays.
  const carried = Object.entries(params).filter(([k, v]) => k !== 'idleDays' && v !== undefined)

  return (
    <div>
      <PageHeader title="Adoption" subtitle={team ? `Team ${team.name}` : undefined} />

      {teams.length > 0 && (
        <Suspense fallback={null}>
          <TeamFilter teams={teams} value={team?.id} />
        </Suspense>
      )}

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
    </div>
  )
}
