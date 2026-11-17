import type { Team, TeamComparison } from '@burn-watch/shared'
import { DAY_MS, fromUtc, toUtc } from './agents'

/**
 * The `teamId` from the URL, kept only when it names a team the viewer can
 * read. A stale or hand-edited id would make the API answer 403/404 and throw
 * the whole page to the error screen; dropping it shows the unfiltered view.
 */
export function pickTeam(teams: Team[], raw: string | undefined): Team | undefined {
  return raw ? teams.find((t) => t.id === raw) : undefined
}

/** One colour per team line. Cycles past seven teams. */
export const TEAM_COLORS = ['#7c3aed', '#3987e5', '#199e70', '#c98500', '#d55181', '#d95926', '#a3a3a3']

export type TeamRow = { date: string } & Record<string, number | string>

/**
 * `/teams/compare` daily series pivoted to one row per day, keyed by teamId,
 * with every day between the first and last reported day filled with 0 for
 * every team. The API leaves days with no usage out.
 */
export function teamDailyRows(teams: TeamComparison[]): TeamRow[] {
  const dates = teams.flatMap((t) => t.daily.map((d) => d.date)).sort()
  if (dates.length === 0) return []

  const cost = new Map(teams.map((t) => [t.teamId, new Map(t.daily.map((d) => [d.date, d.totalCost]))]))
  const rows: TeamRow[] = []
  for (let ms = toUtc(dates[0]); ms <= toUtc(dates[dates.length - 1]); ms += DAY_MS) {
    const date = fromUtc(ms)
    const row: TeamRow = { date }
    for (const t of teams) row[t.teamId] = cost.get(t.teamId)!.get(date) ?? 0
    rows.push(row)
  }
  return rows
}
