import { addDays, type IsoDate } from '@burn-watch/db'
import { ACTIVE_DAYS_PER_WEEK, FEATURE_KEYS, MIN_FEATURES, type OnboardingCounts, type OnboardingResult } from '@burn-watch/shared'
import { featureDays, type FeatureFields } from './features.js'

// Shared, so My usage states the same rules the API applies.
export { ACTIVE_DAYS_PER_WEEK, MIN_FEATURES }
/** Decision 5: a percentage only from 5 finished windows. */
export const MIN_FOR_PERCENT = 5
export const WINDOW_DAYS = 14

const DAY_MS = 86_400_000
/** Day of the window `date` falls on: 1 for the first sync itself. */
const dayOf = (start: IsoDate, date: string) => (Date.parse(date) - Date.parse(start)) / DAY_MS + 1

/**
 * One person's first 14 days from `firstSync`. `tokenDates` are days with
 * tokens (any agent), `docs` their Claude Code enrichment days, and
 * `lastSynced` the newest day whose data is in (today minus 1).
 */
export function onboardingOf(
  firstSync: IsoDate,
  tokenDates: string[],
  docs: (FeatureFields & { date: string })[],
  lastSynced: IsoDate,
): OnboardingResult {
  const inWindow = (d: string) => dayOf(firstSync, d) >= 1 && dayOf(firstSync, d) <= WINDOW_DAYS
  const days = [...new Set(tokenDates.filter(inWindow))].map((d) => dayOf(firstSync, d))
  const activeWeek1 = days.filter((n) => n <= 7).length
  const activeWeek2 = days.filter((n) => n >= 8).length
  const window = docs.filter((d) => inWindow(d.date))
  const used = featureDays(window)
  const features = FEATURE_KEYS.filter((k) => (used[k] ?? 0) > 0)
  const dayOfWindow = Math.min(WINDOW_DAYS, Math.max(1, dayOf(firstSync, lastSynced)))
  const base = { activeWeek1, activeWeek2, features, dayOfWindow }

  // Decision 4: no Claude Code day means features are unknown, not missing.
  if (window.length === 0) return { state: 'noFeatureData', ...base }
  const onboarded =
    activeWeek1 >= ACTIVE_DAYS_PER_WEEK && activeWeek2 >= ACTIVE_DAYS_PER_WEEK && features.length >= MIN_FEATURES
  if (onboarded) return { state: 'onboarded', ...base }
  return { state: addDays(firstSync, WINDOW_DAYS - 1) > lastSynced ? 'inProgress' : 'windowEnded', ...base }
}

export function countOnboarding(results: Pick<OnboardingResult, 'state'>[]): OnboardingCounts {
  const c: OnboardingCounts = { cohort: results.length, onboarded: 0, windowEnded: 0, inProgress: 0, noFeatureData: 0 }
  for (const r of results) c[r.state]++
  return c
}
