import type { AgentName } from '@burn-watch/shared'

/** One API request, as an agent's local log recorded it. Counts and model only. */
export type UsageRecord = {
  agent: AgentName
  model: string
  at: string // ISO timestamp, UTC
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  key: string // dedupe key, unique within one agent
}

/** What a parser skipped or guessed. Printed in the sync summary, never fatal. */
export type ParseStats = {
  files: number
  badLines: number // not JSON, or missing the fields a record needs
  noZone: number // timestamp without a zone, read as UTC
  nonStandard: number // speed or service_tier other than standard, priced at standard
}

export const emptyStats = (): ParseStats => ({ files: 0, badLines: 0, noZone: 0, nonStandard: 0 })

export interface AgentParser {
  agent: AgentName
  /** Folders to read: env override first, then defaults. Missing ones are fine. */
  roots(): string[]
  /** Records from files touched on or after `since` (YYYY-MM-DD, UTC). Not deduped. */
  read(roots: string[], since: string, stats: ParseStats): AsyncIterable<UsageRecord>
}
