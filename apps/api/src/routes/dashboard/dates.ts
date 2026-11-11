import type { IsoDate } from '@burn-watch/db'

const DAY_MS = 86_400_000

/**
 * `n` calendar days before `date`, in UTC and nothing else.
 *
 * The arithmetic this replaces parsed a date with `new Date(str)` — UTC
 * midnight — and then stepped it with `setDate(getDate() - n)`, which reads and
 * writes in the server's local time. In a fixed-offset zone the two cancel out
 * and the answer is right; what they do not survive is a DST transition inside
 * the span, where `setDate` holds the local clock still while the offset
 * underneath it moves, and the resulting instant can land on either side of UTC
 * midnight.
 *
 * Subtracting whole days from a UTC timestamp consults no offset at all, and
 * `Date.UTC` still does the calendar arithmetic across month, year and leap-day
 * ends.
 */
export function daysBefore(date: IsoDate, n: number): IsoDate {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day) - n * DAY_MS).toISOString().slice(0, 10) as IsoDate
}

export const dayBefore = (date: IsoDate): IsoDate => daysBefore(date, 1)

/**
 * Today, in UTC.
 *
 * The one place a wall clock legitimately enters these routes: `/trends?days=N`
 * names a window relative to now rather than by its ends. UTC rather than the
 * server's zone so the window a request gets does not depend on which region
 * the function happens to run in, and so it agrees with the `date` strings the
 * snapshots are keyed by.
 */
export const today = (): IsoDate => new Date().toISOString().slice(0, 10) as IsoDate
