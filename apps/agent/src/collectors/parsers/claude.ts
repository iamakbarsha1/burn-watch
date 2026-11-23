import { createReadStream, existsSync, readdirSync, statSync } from 'fs'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { AgentParser, ParseStats, UsageRecord } from './types.js'

function jsonlFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) jsonlFiles(full, out)
    else if (entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

/** ISO UTC timestamp, or null. A timestamp with no zone is read as UTC and counted. */
export function utcTimestamp(ts: unknown, stats: ParseStats): string | null {
  if (typeof ts !== 'string' || !ts) return null
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(ts)
  const ms = Date.parse(zoned ? ts : `${ts}Z`)
  if (Number.isNaN(ms)) return null
  if (!zoned) stats.noZone++
  return new Date(ms).toISOString()
}

/** One transcript line to a record, or null when it is not a billed request. */
export function claudeRecord(entry: any, stats: ParseStats): UsageRecord | null {
  if (entry?.type !== 'assistant') return null
  const msg = entry.message
  const usage = msg?.usage
  if (!usage || typeof msg.model !== 'string' || !msg.model) return null
  // Local error and limit notices; no API call behind them.
  if (msg.model === '<synthetic>') return null
  const at = utcTimestamp(entry.timestamp, stats)
  if (!at) {
    stats.badLines++
    return null
  }
  for (const v of [usage.speed, usage.service_tier]) if (v !== undefined && v !== 'standard') stats.nonStandard++

  // Without the split (older transcripts) every cache write is a 5-minute one.
  const split = usage.cache_creation
  const cacheWrite5m = split ? count(split.ephemeral_5m_input_tokens) : count(usage.cache_creation_input_tokens)
  const cacheWrite1h = split ? count(split.ephemeral_1h_input_tokens) : 0

  // A streamed reply is written once per content block, and a resumed session
  // copies earlier lines, all with the same ids and usage.
  const key =
    typeof msg.id === 'string' && msg.id && typeof entry.requestId === 'string' && entry.requestId
      ? `${msg.id}:${entry.requestId}`
      : `uuid:${entry.uuid ?? at}`

  return {
    agent: 'claude',
    model: msg.model,
    at,
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheWrite5m,
    cacheWrite1h,
    cacheRead: count(usage.cache_read_input_tokens),
    key,
  }
}

/** Transcript files under the roots, skipping any last written before `since` (YYYY-MM-DD). */
export function claudeFiles(roots: string[], since: string): string[] {
  // Transcripts are append-only, so a file last written before `since` holds nothing new.
  const from = Date.parse(`${since}T00:00:00Z`)
  const files: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const file of jsonlFiles(root)) if (statSync(file).mtimeMs >= from) files.push(file)
  }
  return files
}

/** Each parsed line of one transcript. Lines that are not JSON are counted and skipped. */
export async function* claudeLines(file: string, stats: ParseStats): AsyncIterable<unknown> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    try {
      yield JSON.parse(line)
    } catch {
      stats.badLines++
    }
  }
}

export const claudeParser: AgentParser = {
  agent: 'claude',

  roots() {
    const env = process.env.CLAUDE_CONFIG_DIR
    if (env?.trim()) {
      // Accept the config folder or its projects/ folder.
      return env
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => (basename(d) === 'projects' ? d : join(d, 'projects')))
    }
    return [join(homedir(), '.config', 'claude', 'projects'), join(homedir(), '.claude', 'projects')]
  },

  async *read(roots, since, stats) {
    for (const file of claudeFiles(roots, since)) {
      stats.files++
      for await (const entry of claudeLines(file, stats)) {
        const rec = claudeRecord(entry, stats)
        if (rec) yield rec
      }
    }
  },
}
