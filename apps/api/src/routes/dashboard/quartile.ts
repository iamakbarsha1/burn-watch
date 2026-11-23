import {
  PRACTICE_FEATURES,
  type ChampionReason,
  type FeatureKey,
  type PracticeFeature,
  type PracticeGroup,
  type PracticeTip,
  type TipId,
} from '@burn-watch/shared'

/**
 * R2 A6 Decision 2: below this many people there is no comparison. At 4 to 7
 * the top group is one person; the owner chose that knowingly.
 */
export const MIN_QUARTILE_PEOPLE = 4

/** What the split needs from a person. `rank` is the measure picked by `rankBy`. */
export interface Ranked {
  userId: string
  rank: number
  /** Claude tokens in range: the first tie break. */
  tokens: number
}

/**
 * The one definition of "top quartile" (A7 and D5 import it). Sort by `rank`,
 * then tokens, then userId, so a tie at the cut always lands the same way.
 * Top is the first ceil(n / 4). Null below MIN_QUARTILE_PEOPLE.
 */
export function quartileSplit<T extends Ranked>(people: T[]): { top: T[]; rest: T[] } | null {
  if (people.length < MIN_QUARTILE_PEOPLE) return null
  const sorted = [...people].sort(byRank)
  const cut = Math.ceil(sorted.length / 4)
  return { top: sorted.slice(0, cut), rest: sorted.slice(cut) }
}

/** Highest `rank` first, then tokens, then userId. */
export const byRank = (a: Ranked, b: Ranked) =>
  b.rank - a.rank || b.tokens - a.tokens || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)

/** Middle value, or the mean of the two middle values. Null for no values. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export interface PracticePerson {
  activeDays: number
  days: Record<FeatureKey, number | null>
  mcpServers: number
  /** Token-weighted percent from usageEvents. Null with no Claude tokens in range. */
  cacheHitRate: number | null
}

/** Feature shares and medians for one group. Medians, so one heavy user does not move it. */
export function practiceGroup(people: PracticePerson[]): PracticeGroup {
  const per = (f: (p: PracticePerson) => number) => median(people.map(f)) ?? 0
  const uses = {} as Record<PracticeFeature, number>
  const dayShare = {} as Record<PracticeFeature, number>
  for (const k of PRACTICE_FEATURES) {
    uses[k] = people.length ? people.filter((p) => (p.days[k] ?? 0) > 0).length / people.length : 0
    dayShare[k] = per((p) => (p.activeDays ? (p.days[k] ?? 0) / p.activeDays : 0))
  }
  const rates = people.flatMap((p) => (p.cacheHitRate === null ? [] : [p.cacheHitRate]))
  return { users: people.length, uses, dayShare, mcpServers: per((p) => p.mcpServers), cacheHitRate: median(rates) }
}

/** A6 Decision 4: fixed rules. Feature gaps are shares of people; cache is percentage points / 100. */
export const TIP_THRESHOLDS: Record<TipId, number> = { mcp: 0.25, skills: 0.25, subagents: 0.25, plan: 0.25, cache: 0.1 }

/** Tips whose gap reaches its threshold, largest gap first, at most 3. */
export function practiceTips(top: PracticeGroup, rest: PracticeGroup): PracticeTip[] {
  const gaps: PracticeTip[] = PRACTICE_FEATURES.map((k) => ({ id: k, gap: top.uses[k] - rest.uses[k] }))
  if (top.cacheHitRate !== null && rest.cacheHitRate !== null) {
    gaps.push({ id: 'cache', gap: (top.cacheHitRate - rest.cacheHitRate) / 100 })
  }
  // A tiny epsilon so 0.75 - 0.5 counts as reaching 0.25 despite float error.
  return gaps
    .filter((t) => t.gap >= TIP_THRESHOLDS[t.id] - 1e-9)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 3)
}

/** R2 A7 Decision 2: a team of 2 has no champion, just "the other person". */
export const MIN_CHAMPION_TEAM = 3

export interface ChampionCandidate extends Ranked {
  days: Record<FeatureKey, number | null>
  hidden: boolean
}

/**
 * R2 A7 Decision 1: the top 2 of a team by the picked ranking, no feature
 * floor. Decision 3: `skipHidden` (a manager viewing) leaves out people who
 * hid their name, and the next one takes the slot.
 */
export function suggestChampions<T extends ChampionCandidate>(
  members: T[],
  skipHidden: boolean,
): { reason: ChampionReason; champions: { person: T; uses: PracticeFeature[]; canHelpWith: PracticeFeature[] }[] } {
  if (members.length < MIN_CHAMPION_TEAM) return { reason: 'tooFew', champions: [] }
  const used = (p: T) => PRACTICE_FEATURES.filter((k) => (p.days[k] ?? 0) > 0)
  // Features fewer than half the team uses.
  const rare = PRACTICE_FEATURES.filter((k) => members.filter((p) => (p.days[k] ?? 0) > 0).length * 2 < members.length)
  const champions = members
    .filter((p) => !(skipHidden && p.hidden))
    .sort(byRank)
    .slice(0, 2)
    .map((person) => ({ person, uses: used(person), canHelpWith: used(person).filter((k) => rare.includes(k)) }))
  return { reason: champions.length ? 'ok' : 'noneEligible', champions }
}
