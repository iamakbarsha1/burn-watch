import {
  MIN_GROUP_SIZE,
  PRACTICE_FEATURES,
  type HelpVolunteer,
  type FeatureKey,
  type PracticeFeature,
  type PracticeGroup,
  type PracticeTip,
  type SetupItem,
  type TipId,
} from '@burn-watch/shared'
import { mcpSource } from './governance.js'

/**
 * Below this many people there is no comparison. v2 rule 2 replaces R2 A6
 * Decision 2 (a floor of 4, where the top group could be one person): the top
 * group, ceil(n / 4) people, must itself reach MIN_GROUP_SIZE, so n >= 17.
 */
export const MIN_QUARTILE_PEOPLE = 4 * (MIN_GROUP_SIZE - 1) + 1

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

/**
 * v2 Phase 2: the people in a team who set "happy to help" themselves, by
 * name, with the features they used that fewer than half of the team used.
 * Nobody is picked by usage.
 */
export function teamVolunteers<T extends { userId: string; name: string; helpVolunteer: boolean; days: Record<FeatureKey, number | null> }>(
  members: T[],
): HelpVolunteer[] {
  const used = (p: T) => PRACTICE_FEATURES.filter((k) => (p.days[k] ?? 0) > 0)
  const rare = PRACTICE_FEATURES.filter((k) => members.filter((p) => (p.days[k] ?? 0) > 0).length * 2 < members.length)
  return members
    .filter((p) => p.helpVolunteer)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ userId: p.userId, name: p.name, canHelpWith: used(p).filter((k) => rare.includes(k)) }))
}

/** R2 D5 Decision 5: an item needs 2 people, so a one-person tool never shows. */
export const MIN_SETUP_PEOPLE = 2

/**
 * MCP servers the reference group shares: used by at least half of it and
 * by at least 2 people. Unnamed (UUID) servers are skipped. `approved` is
 * null when approvals do not apply to this viewer (D5 Decision 3: show all,
 * badge the rest).
 */
export function recommendedSetup(
  group: { servers: string[] }[],
  everyone: { servers: string[] }[],
  approved: Set<string> | null,
): { reason: 'ok' | 'smallGroup'; items: SetupItem[] } {
  if (group.length < MIN_SETUP_PEOPLE) return { reason: 'smallGroup', items: [] }
  const tally = (people: { servers: string[] }[]) => {
    const n = new Map<string, number>()
    for (const p of people) for (const k of new Set(p.servers)) n.set(k, (n.get(k) ?? 0) + 1)
    return n
  }
  const top = tally(group)
  const all = tally(everyone)
  const items: SetupItem[] = []
  for (const [key, topUsers] of top) {
    const source = mcpSource(key)
    if (source === 'unnamed' || topUsers < MIN_SETUP_PEOPLE || topUsers * 2 < group.length) continue
    items.push({ key, source, topUsers, teamUsers: all.get(key) ?? topUsers, approved: approved ? approved.has(key) : null })
  }
  items.sort((a, b) => b.topUsers - a.topUsers || b.teamUsers - a.teamUsers || (a.key < b.key ? -1 : 1))
  return { reason: 'ok', items }
}
