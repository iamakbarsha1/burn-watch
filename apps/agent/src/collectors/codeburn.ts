import { existsSync, readdirSync, statSync } from 'fs'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { ClaudeEnrichment } from '@burn-watch/shared'
import type { EnrichmentCollector } from './base.js'

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB — skip files larger than this

function findJsonlFiles(dir: string): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...findJsonlFiles(fullPath))
    } else if (entry.name.endsWith('.jsonl')) {
      files.push(fullPath)
    }
  }
  return files
}

// A transcript records the cwd of the turn, so one repo worked from its root
// and from two app directories arrives as three projects. Group on the
// enclosing checkout instead. A cwd that is gone, or was never in a repo,
// stays as it is.
function projectRoot(cwd: string, memo: Map<string, string>): string {
  const cached = memo.get(cwd)
  if (cached) return cached
  let dir = cwd
  while (true) {
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) {
      dir = cwd
      break
    }
    dir = parent
  }
  memo.set(cwd, dir)
  return dir
}

interface ProjectBucket {
  sessions: Set<string>
  tokens: number
  cacheReadTokens: number
}

interface DateBucket {
  sessions: Set<string>
  callCount: number
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
  projects: Map<string, ProjectBucket>
  toolUsage: Record<string, number>
  shellUsage: Record<string, number>
  mcpUsage: Record<string, number>
}

function newBucket(): DateBucket {
  return {
    sessions: new Set(),
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    projects: new Map(),
    toolUsage: {},
    shellUsage: {},
    mcpUsage: {},
  }
}

export class CodeburnCollector implements EnrichmentCollector {
  constructor(private claudeDir: string = join(homedir(), '.claude', 'projects')) {}

  async isAvailable(): Promise<boolean> {
    return existsSync(this.claudeDir)
  }

  async collect(date: string, claudeCostUsd = 0): Promise<ClaudeEnrichment | null> {
    const result = await this.collectRange([date], new Map([[date, claudeCostUsd]]))
    return result.get(date) ?? null
  }

  // Single pass over all JSONL files, accumulates data for all requested dates simultaneously.
  //
  // `claudeCostByDate` carries the authoritative per-day Claude spend from
  // ccusage. The transcripts hold token counts but no prices, and the project
  // sees ccusage as the only source of a cost figure, so per-project cost is
  // that day's total split by each project's share of the day's tokens — never
  // priced here independently.
  async collectRange(
    dates: string[],
    claudeCostByDate: Map<string, number> = new Map(),
  ): Promise<Map<string, ClaudeEnrichment>> {
    const files = findJsonlFiles(this.claudeDir)
    const dateSet = new Set(dates)
    const buckets = new Map<string, DateBucket>()
    const rootCache = new Map<string, string>()

    for (const file of files) {
      const stat = statSync(file)
      if (stat.size > MAX_FILE_SIZE) {
        console.warn(`[burnwatch][codeburn] skipping large file (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${file}`)
        continue
      }

      const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
      try {
        for await (const line of rl) {
          if (!line) continue
          let entry: any
          try { entry = JSON.parse(line) } catch { continue }

          const ts: string = entry.timestamp ?? entry.message?.timestamp ?? ''
          const date = ts.slice(0, 10)
          if (!dateSet.has(date)) continue

          if (!buckets.has(date)) buckets.set(date, newBucket())
          const b = buckets.get(date)!

          if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
            b.callCount++

            const sessionId: string = entry.sessionId ?? entry.session_id ?? ''
            if (sessionId) b.sessions.add(sessionId)

            const u = entry.message.usage ?? {}
            const input = u.input_tokens ?? 0
            const output = u.output_tokens ?? 0
            const cacheCreate = u.cache_creation_input_tokens ?? 0
            const cacheRead = u.cache_read_input_tokens ?? 0
            b.inputTokens += input
            b.outputTokens += output
            b.cacheCreateTokens += cacheCreate
            b.cacheReadTokens += cacheRead

            const cwd: string = entry.cwd ?? ''
            if (cwd) {
              const root = projectRoot(cwd, rootCache)
              let p = b.projects.get(root)
              if (!p) {
                p = { sessions: new Set(), tokens: 0, cacheReadTokens: 0 }
                b.projects.set(root, p)
              }
              if (sessionId) p.sessions.add(sessionId)
              p.tokens += input + output + cacheCreate + cacheRead
              p.cacheReadTokens += cacheRead
            }

            const content = entry.message.content ?? []
            for (const block of content) {
              if (block.type === 'tool_use') {
                const toolName = (block.name ?? '').toLowerCase()
                if (toolName === 'bash') {
                  const cmd = (block.input?.command ?? '').trim().split(/\s+/)[0]
                  if (cmd) b.shellUsage[cmd] = (b.shellUsage[cmd] ?? 0) + 1
                } else if (toolName.startsWith('mcp__') || (block.name ?? '').startsWith('mcp__')) {
                  const server = (block.name ?? '').split('__')[1] ?? ''
                  if (server) b.mcpUsage[server] = (b.mcpUsage[server] ?? 0) + 1
                } else {
                  b.toolUsage[toolName] = (b.toolUsage[toolName] ?? 0) + 1
                }
              }
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    const result = new Map<string, ClaudeEnrichment>()
    for (const [date, b] of buckets) {
      if (b.callCount === 0) continue

      const readable = b.inputTokens + b.cacheCreateTokens + b.cacheReadTokens
      const dayTokens = readable + b.outputTokens
      const dayCost = claudeCostByDate.get(date) ?? 0

      result.set(date, {
        date,
        sessionCount: b.sessions.size,
        callCount: b.callCount,
        cacheHitRate: readable > 0 ? (b.cacheReadTokens / readable) * 100 : 0,
        writtenTokens: b.outputTokens,
        // ponytail: no reader. Nothing in the API or the dashboard selects
        // activity_breakdown or top_sessions, and OrgActivitySummary is
        // declared but referenced nowhere. Fill these when a page wants them.
        activityBreakdown: [],
        topSessions: [],
        projectBreakdown: Array.from(b.projects.entries()).map(([path, p]) => {
          // ponytail: tokens are a flat weight, so a project on a cheaper
          // model is charged above its real share. Weight by model price if
          // the split ever has to be exact.
          const cost = dayTokens > 0 ? dayCost * (p.tokens / dayTokens) : 0
          const sessions = p.sessions.size
          return {
            path,
            cost,
            sessions,
            avgPerSession: sessions > 0 ? cost / sessions : 0,
            overheadK: p.cacheReadTokens / 1000,
          }
        }),
        toolUsage: b.toolUsage,
        shellUsage: b.shellUsage,
        mcpUsage: b.mcpUsage,
      })
    }
    return result
  }
}
