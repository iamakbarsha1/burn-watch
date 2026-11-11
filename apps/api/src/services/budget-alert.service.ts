import {
  monthToDateSpend,
  type BudgetAlertDoc,
  type IsoDate,
  type OrgId,
  type Store,
  type UserId,
} from '@burn-watch/db'

function isoMonth(d: Date): string {
  return d.toISOString().slice(0, 7)
}

/**
 * Re-evaluates every budget alert a submitted snapshot could affect: the
 * org-wide ones, and any scoped to this one user. Runs inside the same
 * transaction as the snapshot rebuild that triggers it, so a failure here
 * rolls back the whole submission along with it.
 *
 * Takes a Store rather than a Txn so the GET route can call its way down to
 * the same evaluation without opening a transaction for a read. A Txn is a
 * Store, so a caller inside one passes it unchanged and keeps the guarantee.
 */
export async function evaluateBudgetAlerts(
  store: Store,
  orgId: OrgId,
  userId: UserId,
  date: IsoDate,
): Promise<void> {
  // `userId: null` is the org-wide alert, and it is a stored null rather than
  // an absent field, so naming it here matches it.
  const alerts = await store.budgetAlerts.find({ orgId, $or: [{ userId: null }, { userId }] })
  for (const alert of alerts) {
    await applyTrip(store, alert, date)
  }
}

/**
 * Re-evaluates one alert by id, for the CRUD routes to call after they write.
 *
 * Without this an admin who sets a limit below current spend is told OK —
 * directly beside the month-to-date figure that contradicts it — and stays
 * told that until the next agent sync happens to run the evaluation. The
 * write that changes the answer is the write that has to record it.
 *
 * An alert in another org, or one already deleted, is a no-op rather than an
 * error: the caller has already answered for whether it exists.
 */
export async function evaluateBudgetAlert(
  store: Store,
  orgId: OrgId,
  id: string,
  date: IsoDate,
): Promise<void> {
  const alert = await store.budgetAlerts.findOne({ _id: id, orgId })
  if (!alert) return
  await applyTrip(store, alert, date)
}

/**
 * The boundary is inclusive, spend >= trip point, never `>`: a $100 limit at
 * its default 80% threshold trips the moment spend reaches $80, not after it.
 *
 * Both sides of that comparison are whole micros. `monthlyLimitMicros` is an
 * integer and `threshold` is a ratio, so their product is a float that can
 * land an ulp either side of the figure it means, and an inclusive boundary
 * compared against a float is inclusive only by luck. Rounding to micros makes
 * it exact, and costs nothing real: no spend is ever a fraction of a micro.
 *
 * `trippedAt` latches for the calendar month it was set in. Crossing into
 * tripped territory this month sets it to now; dropping back under the trip
 * point while still in that same month (the limit got raised) clears it back
 * to null. A trip from an earlier month is left untouched — the read side
 * already treats a stale month as untripped, so there is nothing to undo.
 */
async function applyTrip(store: Store, alert: BudgetAlertDoc, date: IsoDate): Promise<void> {
  const monthKey = date.slice(0, 7)
  const spend = await monthToDateSpend(store, alert.orgId, alert.userId, alert.agent, date)
  const tripPoint = Math.round(alert.monthlyLimitMicros * alert.threshold)
  const shouldTrip = spend >= tripPoint
  const trippedMonth = alert.trippedAt ? isoMonth(alert.trippedAt) : null

  if (shouldTrip && trippedMonth !== monthKey) {
    await store.budgetAlerts.updateOne({ _id: alert._id }, { $set: { trippedAt: new Date() } })
  } else if (!shouldTrip && trippedMonth === monthKey) {
    await store.budgetAlerts.updateOne({ _id: alert._id }, { $set: { trippedAt: null } })
  }
}
