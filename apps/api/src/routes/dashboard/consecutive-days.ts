import type { ConsecutiveDays } from '@burn-watch/shared'

const DAY_MS = 86_400_000

/** Whole UTC days since the epoch. */
const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS)
const isWeekday = (day: number) => {
  const dow = new Date(day * DAY_MS).getUTCDay()
  return dow !== 0 && dow !== 6
}

/** True when no weekday lies strictly between days a and b. */
function noWeekdayBetween(a: number, b: number): boolean {
  // Any three days in a row hold a weekday, so a longer gap breaks without a look.
  if (b - a - 1 >= 3) return false
  for (let d = a + 1; d < b; d++) if (isWeekday(d)) return false
  return true
}

/**
 * Current and longest run of consecutive active days (UTC dates), all time.
 *
 * A run is active days with no weekday left out in between:
 * Saturday and Sunday never break one, and activity on them still counts.
 * `today` and the day before never break the current run, since their data
 * is usually not synced yet. Lengths count active days, not calendar days.
 * Shared with D1 (AI Wrapped), so it stays a pure function.
 */
export function consecutiveDays(dates: string[], today: string): ConsecutiveDays {
  const days = [...new Set(dates)].map(dayNumber).sort((a, b) => a - b)
  if (days.length === 0) return { current: 0, longest: 0, lastActive: null }

  let longest = 1
  let run = 1
  for (let i = 1; i < days.length; i++) {
    run = noWeekdayBetween(days[i - 1], days[i]) ? run + 1 : 1
    longest = Math.max(longest, run)
  }
  const last = days[days.length - 1]
  // The last run is live when nothing up to two days ago breaks it.
  const alive = noWeekdayBetween(last, Math.max(last, dayNumber(today) - 1))
  return {
    current: alive ? run : 0,
    longest,
    lastActive: new Date(last * DAY_MS).toISOString().slice(0, 10),
  }
}
