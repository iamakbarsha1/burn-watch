import type { ClaudeEnrichmentDoc } from '@burn-watch/db'
import { FEATURE_KEYS, type FeatureCounts, type FeatureKey, type FeaturePerson } from '@burn-watch/shared'

/** The enrichment fields A5 reads. Every one may be null or absent on old days. */
export type FeatureFields = Partial<
  Pick<
    ClaudeEnrichmentDoc,
    'toolUsage' | 'mcpUsage' | 'skillCounts' | 'sidechainMessages' | 'permissionModeCounts' | 'entrypointCounts'
  >
>

const any = (m: Record<string, number> | null | undefined) => !!m && Object.values(m).some((n) => n > 0)
const has = (m: Record<string, number> | null | undefined, ...keys: string[]) => keys.some((k) => (m?.[k] ?? 0) > 0)

/**
 * R2 A5 Decision 1: one Claude Code day as five flags. Tool calls first, because
 * every agent version sends them (tool names arrive lower-cased); the 0.4.0
 * fields are a second source. `sdk` is null when the day predates 0.4.0.
 */
export function featureFlags(doc: FeatureFields): Record<FeatureKey, boolean | null> {
  const tools = doc.toolUsage
  return {
    mcp: any(doc.mcpUsage),
    // skillCounts comes from attributionSkill, which Claude Code sets on few lines.
    skills: has(tools, 'skill') || any(doc.skillCounts),
    // The subagent tool was named Task before it was Agent.
    subagents: has(tools, 'agent', 'task') || (doc.sidechainMessages ?? 0) > 0,
    plan: has(tools, 'exitplanmode', 'enterplanmode') || has(doc.permissionModeCounts, 'plan'),
    sdk: doc.entrypointCounts ? Object.keys(doc.entrypointCounts).some((k) => k !== 'cli') : null,
  }
}

/** Days each feature was used across one person's days; `sdk` stays null with no 0.4.0 day. */
export function featureDays(docs: FeatureFields[]): Record<FeatureKey, number | null> {
  const days = { mcp: 0, skills: 0, subagents: 0, plan: 0, sdk: null } as Record<FeatureKey, number | null>
  for (const doc of docs) {
    for (const [key, on] of Object.entries(featureFlags(doc)) as [FeatureKey, boolean | null][]) {
      if (on === null) continue
      days[key] = (days[key] ?? 0) + (on ? 1 : 0)
    }
  }
  return days
}

/** Decision 2: "used" means at least one day in range. */
export function countFeatures(people: Pick<FeaturePerson, 'days'>[]): FeatureCounts {
  const used = Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0])) as Record<FeatureKey, number>
  let sdkKnown = 0
  for (const p of people) {
    for (const k of FEATURE_KEYS) if ((p.days[k] ?? 0) > 0) used[k]++
    if (p.days.sdk !== null) sdkKnown++
  }
  return { users: people.length, used, sdkKnown }
}
