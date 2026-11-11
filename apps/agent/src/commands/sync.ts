import { ApiClient } from '../lib/api.js'
import { loadConfig, updateConfig } from '../lib/config.js'
import { CcusageCollector } from '../collectors/ccusage.js'
import { CodeburnCollector } from '../collectors/codeburn.js'

// ccusage is the only source of a cost figure. The codeburn pass needs the
// day's Claude spend to split it across projects.
function claudeCost(events: import('@burn-watch/shared').UsageEvent[]): number {
  return events.reduce((sum, e) => (e.agent === 'claude' ? sum + e.costUsd : sum), 0)
}

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

  const ccusage = new CcusageCollector(config.npxPath ?? 'npx')
  const codeburn = new CodeburnCollector()

  const ccAvailable = await ccusage.isAvailable()
  const cbAvailable = await codeburn.isAvailable()

  if (!ccAvailable) {
    console.warn('[burnwatch] ccusage not available — no local AI log directories found')
  }

  console.log(`[burnwatch] Syncing ${dates.length} date(s)...`)

  // Pre-collect everything in single passes when syncing multiple dates
  let eventsMap: Map<string, import('@burn-watch/shared').UsageEvent[]> | null = null
  let enrichmentMap: Map<string, import('@burn-watch/shared').ClaudeEnrichment> | null = null

  if (dates.length > 1) {
    if (ccAvailable) {
      console.log('[burnwatch] Fetching ccusage for full date range (single call)...')
      eventsMap = await ccusage.collectRange(dates)
      console.log(`[burnwatch] Found ccusage data for ${eventsMap.size} date(s)`)
    }
    if (cbAvailable) {
      console.log('[burnwatch] Scanning JSONL files (single pass)...')
      const costByDate = new Map<string, number>()
      for (const [date, events] of eventsMap ?? []) {
        costByDate.set(date, claudeCost(events))
      }
      enrichmentMap = await codeburn.collectRange(dates, costByDate)
      console.log(`[burnwatch] Found enrichment for ${enrichmentMap.size} date(s)`)
    }
  }

  for (const date of dates) {
    console.log(`[burnwatch][sync] ${date}`)

    const events = eventsMap
      ? (eventsMap.get(date) ?? [])
      : ccAvailable ? await ccusage.collect(date) : []
    const enrichment = enrichmentMap
      ? (enrichmentMap.get(date) ?? null)
      : cbAvailable ? await codeburn.collect(date, claudeCost(events)) : null

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
      })

      const claudeEvent = events.find((e) => e.agent === 'claude')
      const qwenEvent = events.find((e) => e.agent === 'qwen')

      console.log(
        `  Accepted: ${result.accepted} | Skipped: ${result.skipped}` +
        (claudeEvent ? ` | Claude: $${claudeEvent.costUsd.toFixed(2)}` : '') +
        (qwenEvent ? ` | Qwen: ${(qwenEvent.totalTokens / 1_000_000).toFixed(1)}M tokens (free)` : '')
      )
    } catch (err: any) {
      console.error(`  Error: ${err.message}`)
    }
  }

  updateConfig({ lastSyncAt: new Date().toISOString() })
  console.log('[burnwatch] Done')
}
