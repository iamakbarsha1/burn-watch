import { and, eq, gte, isNull, lt, or, sum } from 'drizzle-orm'
import { budgetAlerts, dailySnapshots } from '../../drizzle/schema.js'
import type { DbOrTx } from '../plugins/db.js'

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const AGENT_COST_COLUMN = {
  claude: dailySnapshots.claudeCostUsd,
  qwen: dailySnapshots.qwenCostUsd,
  gemini: dailySnapshots.geminiCostUsd,
  codex: dailySnapshots.codexCostUsd,
  copilot: dailySnapshots.copilotCostUsd,
} as const

export function costColumnFor(agent: string | null) {
  if (agent && agent in AGENT_COST_COLUMN) {
    return AGENT_COST_COLUMN[agent as keyof typeof AGENT_COST_COLUMN]
  }
  return dailySnapshots.totalCostUsd
}

// Half-open [start, end) over the `date` column, which `rebuildDailySnapshot`
// stores as plain YYYY-MM-DD strings, so this stays string arithmetic too
// rather than mixing in a Date and its timezone.
function monthRange(date: string): [string, string] {
  const [year, month] = date.slice(0, 7).split('-').map(Number)
  const start = `${date.slice(0, 7)}-01`
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  const end = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
  return [start, end]
}

function isoMonth(d: Date): string {
  return d.toISOString().slice(0, 7)
}

/**
 * Month-to-date spend for one alert's scope: the whole org, or one user of
 * it, and either one agent's column or the all-agent total. Shared by the
 * evaluator below and by the GET route, so a read never drifts from what the
 * last evaluation saw.
 */
export async function monthToDateSpend(
  db: DbOrTx,
  orgId: string,
  userId: string | null,
  agent: string | null,
  date: string,
): Promise<number> {
  const [monthStart, monthEnd] = monthRange(date)
  const column = costColumnFor(agent)
  const conditions = [
    eq(dailySnapshots.orgId, orgId),
    gte(dailySnapshots.date, monthStart),
    lt(dailySnapshots.date, monthEnd),
  ]
  if (userId) conditions.push(eq(dailySnapshots.userId, userId))

  const [row] = await db
    .select({ spend: sum(column).mapWith(Number) })
    .from(dailySnapshots)
    .where(and(...conditions))

  return toNumber(row?.spend)
}

/**
 * Re-evaluates every budget alert a submitted snapshot could affect: the
 * org-wide ones, and any scoped to this one user. Runs inside the same
 * transaction as the snapshot rebuild that triggers it, so a failure here
 * rolls back the whole submission along with it.
 *
 * The boundary is inclusive, spend >= trip point, never `>`: a $100 limit at
 * its default 80% threshold trips the moment spend reaches $80, not after it.
 *
 * `trippedAt` latches for the calendar month it was set in. Crossing into
 * tripped territory this month sets it to now; dropping back under the trip
 * point while still in that same month (the limit got raised) clears it back
 * to null. A trip from an earlier month is left untouched — the read side
 * already treats a stale month as untripped, so there is nothing to undo.
 */
export async function evaluateBudgetAlerts(
  db: DbOrTx,
  orgId: string,
  userId: string,
  date: string,
): Promise<void> {
  const alerts = await db
    .select()
    .from(budgetAlerts)
    .where(
      and(
        eq(budgetAlerts.orgId, orgId),
        or(isNull(budgetAlerts.userId), eq(budgetAlerts.userId, userId)),
      ),
    )

  if (alerts.length === 0) return

  const monthKey = date.slice(0, 7)

  for (const alert of alerts) {
    const spend = await monthToDateSpend(db, orgId, alert.userId, alert.agent, date)
    const tripPoint = Number(alert.monthlyLimitUsd) * Number(alert.threshold)
    const shouldTrip = spend >= tripPoint
    const trippedMonth = alert.trippedAt ? isoMonth(alert.trippedAt) : null

    if (shouldTrip && trippedMonth !== monthKey) {
      await db.update(budgetAlerts).set({ trippedAt: new Date() }).where(eq(budgetAlerts.id, alert.id))
    } else if (!shouldTrip && trippedMonth === monthKey) {
      await db.update(budgetAlerts).set({ trippedAt: null }).where(eq(budgetAlerts.id, alert.id))
    }
  }
}
