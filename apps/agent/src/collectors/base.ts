import type { UsageEvent, ClaudeEnrichment } from '@burn-watch/shared'

export interface UsageCollector {
  isAvailable(): Promise<boolean>
  collect(date: string): Promise<UsageEvent[]>
}

export interface EnrichmentCollector {
  isAvailable(): Promise<boolean>
  collect(date: string): Promise<ClaudeEnrichment | null>
}
