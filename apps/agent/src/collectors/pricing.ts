import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { PriceTableSchema, type ModelPrice, type PriceTable } from '@burn-watch/shared'
import { PRICE_TABLE } from '@burn-watch/shared/prices'
import type { UsageRecord } from './parsers/types.js'

export const PRICE_CACHE = join(homedir(), '.burnwatch', 'prices.json')
const DAY_MS = 24 * 60 * 60 * 1000

export function lookupPrice(table: PriceTable, model: string): ModelPrice | null {
  return table.models[model] ?? table.models[table.aliases[model] ?? ''] ?? null
}

/**
 * USD for one request at API list price, or null when the model has no price.
 * Per request, not per day: the 200k tier and the 5m/1h split are per request.
 * Over 200k prompt tokens (cache included) the whole request moves to the
 * higher tier, as Anthropic and Google publish it.
 */
export function priceRecord(table: PriceTable, r: UsageRecord): number | null {
  const m = lookupPrice(table, r.model)
  if (!m) return null
  const prompt = r.input + r.cacheWrite5m + r.cacheWrite1h + r.cacheRead
  const p = prompt > 200_000 && m.above200k ? { ...m, ...m.above200k } : m
  // shortcut: a missing cache price counts as 0, as LiteLLM consumers do; upgrade if parity shows a gap.
  const w5 = p.cacheWrite5m ?? 0
  return (
    r.input * p.input +
    r.output * p.output +
    r.cacheWrite5m * w5 +
    r.cacheWrite1h * (p.cacheWrite1h ?? w5) +
    r.cacheRead * (p.cacheRead ?? 0)
  )
}

function readCache(file: string): PriceTable | null {
  try {
    return PriceTableSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/** The newer of the cached table and the one built into the binary. */
export function loadPriceTable(file = PRICE_CACHE, embedded: PriceTable = PRICE_TABLE): PriceTable {
  const cached = existsSync(file) ? readCache(file) : null
  // Versions start with YYYY-MM-DD, so string order is date order.
  return cached && cached.version > embedded.version ? cached : embedded
}

/**
 * Fetch GET /v1/prices at most once a day into the cache. Never throws: a sync
 * must not fail on prices, and the embedded table is always there.
 */
export async function refreshPrices(
  apiUrl: string,
  file = PRICE_CACHE,
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch,
  now = Date.now(),
): Promise<'fresh' | 'updated' | 'unchanged' | 'failed'> {
  try {
    if (existsSync(file) && now - statSync(file).mtimeMs < DAY_MS) return 'fresh'
    const current = loadPriceTable(file)
    const res = await fetchFn(`${apiUrl}/v1/prices`, {
      headers: { 'If-None-Match': `"${current.version}"` },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 304) {
      if (existsSync(file)) utimesSync(file, new Date(now), new Date(now))
      else writeFileSync(file, JSON.stringify(current))
      return 'unchanged'
    }
    if (!res.ok) return 'failed'
    const table = PriceTableSchema.parse(await res.json())
    writeFileSync(file, JSON.stringify(table))
    return 'updated'
  } catch {
    return 'failed'
  }
}
