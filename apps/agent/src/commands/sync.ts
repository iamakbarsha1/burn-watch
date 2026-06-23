import { ApiClient } from '../lib/api.js'
import { loadConfig, updateConfig } from '../lib/config.js'
import { CcusageCollector } from '../collectors/ccusage.js'
import { CodeburnCollector } from '../collectors/codeburn.js'

function yesterdayDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
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

export async function syncCommand(options: { date?: string; last7?: boolean; days?: string }) {
  const config = loadConfig()
  const api = new ApiClient(config.apiUrl, config.accessToken)

  let dates: string[]
  if (options.days) {
    dates = datesForLastN(parseInt(options.days, 10))
  } else if (options.last7) {
    dates = datesForLastN(7)
  } else if (options.date) {
    dates = [options.date]
  } else {
    dates = [yesterdayDate()]
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
      enrichmentMap = await codeburn.collectRange(dates)
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
