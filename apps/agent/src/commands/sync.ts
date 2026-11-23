import { ApiClient } from '../lib/api.js'
import { loadConfig, updateConfig } from '../lib/config.js'
import { CodeburnCollector } from '../collectors/codeburn.js'
import { UsageCollector } from '../collectors/usage.js'
import { refreshPrices } from '../collectors/pricing.js'
import { AGENT_VERSION } from '../version.js'
import type { ClaudeEnrichment, DeviceConfig, UsageEvent } from '@burn-watch/shared'

function yesterdayDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function datesForLastN(n: number): string[] {
  const dates: string[] = []
  for (let i = n; i >= 1; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    dates.push(d.toISOString().slice(0, 10))
  }
  return dates
}

export function selectDates(options: {
  date?: string
  last7?: boolean
  days?: string
  today?: boolean
}): string[] {
  if (options.days) {
    // commander hands --days the next token when no number follows it, so
    // `--days --today` arrives as days === '--today'. Unchecked, that became
    // NaN and a zero-date sync indistinguishable from the deliberate --days 0.
    const n = Number(options.days)
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`--days must be a non-negative whole number, got "${options.days}"`)
    }
    return datesForLastN(n)
  }
  if (options.last7) return datesForLastN(7)
  if (options.date) return [options.date]
  if (options.today) return [todayDate()]
  return [yesterdayDate()]
}

/**
 * The first UTC day this collector may send. The server keeps the first rows
 * sent for a day, so a day the previous collector already sent is not re-sent:
 * a device that synced before gets the UTC day of its last sync. The previous
 * collector sent the day before that one by default. A new device has no cutover.
 */
export function cutoverDay(config: Pick<DeviceConfig, 'lastSyncAt' | 'ownCollectorFrom'>): string | null {
  if (config.ownCollectorFrom !== undefined) return config.ownCollectorFrom
  return config.lastSyncAt ? config.lastSyncAt.slice(0, 10) : null
}

export async function syncCommand(options: {
  date?: string
  last7?: boolean
  days?: string
  today?: boolean
  apiUrl?: string
}) {
  const config = loadConfig()
  // `sync` used to take whatever host the stored config happened to hold and
  // say nothing about it. Running it right after setting up a local install
  // would submit to whichever BurnWatch this machine was last registered with
  // — production, in the case that found this — with the only evidence being
  // the URLs in a failure message, if it failed at all. The host is now the
  // first thing printed, and `--api-url` overrides it for one run.
  const apiUrl = options.apiUrl ?? config.apiUrl
  const api = new ApiClient(apiUrl, config.accessToken)

  console.log(`[burnwatch] Target: ${apiUrl}`)
  if (options.apiUrl && options.apiUrl !== config.apiUrl) {
    console.log(`  Overriding the registered host for this run (${config.apiUrl})`)
  }

  let dates: string[]
  try {
    dates = selectDates(options)
  } catch (err) {
    console.error(`[burnwatch] ${(err as Error).message}`)
    process.exit(1)
  }

  const from = cutoverDay(config)
  if (config.ownCollectorFrom === undefined) updateConfig({ ownCollectorFrom: from })
  const before = from ? dates.filter((d) => d < from) : []
  if (before.length) {
    console.log(`[burnwatch] Not re-sending ${before.length} day(s) before ${from}: the previous collector sent them`)
    dates = dates.filter((d) => !before.includes(d))
  }

  // Prices first: both collectors price requests.
  await refreshPrices(apiUrl)
  const usage = new UsageCollector()
  const codeburn = new CodeburnCollector(undefined, config.orgId)

  const usageAvailable = await usage.isAvailable()
  const cbAvailable = await codeburn.isAvailable()

  if (!usageAvailable) {
    console.warn('[burnwatch] No local Claude Code logs found')
  }

  console.log(`[burnwatch] Syncing ${dates.length} date(s)...`)

  // One pass over the logs for the whole range.
  const eventsMap = usageAvailable ? await usage.collectRange(dates) : new Map<string, UsageEvent[]>()
  let enrichmentMap: Map<string, ClaudeEnrichment> | null = null
  if (dates.length > 1 && cbAvailable) {
    console.log('[burnwatch] Scanning JSONL files (single pass)...')
    enrichmentMap = await codeburn.collectRange(dates)
    console.log(`[burnwatch] Found enrichment for ${enrichmentMap.size} date(s)`)
  }
  const unpriced = Object.entries(usage.summary.unpriced)
  if (unpriced.length) {
    console.warn(`[burnwatch] No price for: ${unpriced.map(([m, t]) => `${m} (${t.toLocaleString('en-US')} tokens)`).join(', ')}`)
  }

  for (const date of dates) {
    console.log(`[burnwatch][sync] ${date}`)

    const events = eventsMap.get(date) ?? []
    const enrichment = enrichmentMap
      ? (enrichmentMap.get(date) ?? null)
      : cbAvailable ? await codeburn.collect(date) : null

    if (events.length === 0 && !enrichment) {
      console.log(`  Skipped — no data`)
      continue
    }

    try {
      const result = await api.postUsage({
        deviceId: config.deviceId,
        date,
        events,
        enrichment,
        agentVersion: AGENT_VERSION,
      })

      const claudeCostTotal = events.filter((e) => e.agent === 'claude').reduce((sum, e) => sum + e.costUsd, 0)
      console.log(
        `  Accepted: ${result.accepted} | Skipped: ${result.skipped}` +
        (events.length ? ` | Claude: $${claudeCostTotal.toFixed(2)}` : ''),
      )
    } catch (err: any) {
      console.error(`  Error: ${err.message}`)
    }
  }

  updateConfig({
    lastSyncAt: new Date().toISOString(),
    repoAccessWarning: codeburn.repoWarning,
  })
  console.log('[burnwatch] Done')
}
