import { existsSync, statSync } from 'fs'
import { dirname } from 'path'
import { createHmac } from 'crypto'
import type { ClaudeEnrichment, PriceTable } from '@burn-watch/shared'
import type { EnrichmentCollector } from './base.js'
import { probeGit, repoIdentity, run, sshHostResolver, type RepoIdentity, type Run } from './repo.js'
import { claudeFiles, claudeLines, claudeParser, claudeRecord, utcTimestamp } from './parsers/claude.js'
import { emptyStats } from './parsers/types.js'
import { loadPriceTable, priceRecord } from './pricing.js'

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB — skip files larger than this

// A transcript records the cwd of the turn, so one repo worked from its root
// and from two app directories arrives as three projects. Group on the
// enclosing checkout instead. A cwd that is gone, or was never in a repo,
// stays as it is. So does one we may not read: a repo further up would be a
// guess, and `repoIdentity` reports the block.
function projectRoot(cwd: string, memo: Map<string, string>): string {
  const cached = memo.get(cwd)
  if (cached) return cached
  let dir = cwd
  while (true) {
    const git = probeGit(dir)
    if (git === 'repo') break
    const parent = dirname(dir)
    if (git === 'denied' || parent === dir) {
      dir = cwd
      break
    }
    dir = parent
  }
  memo.set(cwd, dir)
  return dir
}

/**
 * One line for every repo macOS kept us out of. A launchd job has its own
 * privacy grant, so the scheduled sync can be blocked from ~/Desktop while the
 * same binary run from a shell is not.
 */
export async function deniedWarning(ids: Iterable<Promise<RepoIdentity>>): Promise<string | null> {
  const folders = new Set<string>()
  let repos = 0
  for (const id of ids) {
    const { denied } = await id
    if (!denied) continue
    folders.add(denied)
    repos++
  }
  if (repos === 0) return null
  return (
    `macOS blocked reading ${[...folders].join(', ')} (${repos} repo${repos === 1 ? '' : 's'} sent without a remote). ` +
    'Allow "burnwatch" in System Settings > Privacy & Security > Files and Folders (or Full Disk Access).'
  )
}

// Claude Code records a usage-limit stop as a synthetic assistant entry flagged
// `isApiErrorMessage`. Current CLIs write "You've hit your session limit · resets
// 3pm"; older ones wrote "Claude AI usage limit reached|<epoch>" or
// "5-hour limit reached ∙ resets 3pm". The flag keeps Claude's own prose about
// limits from counting.
const LIMIT_NOTICE = /You've hit your .*limit|limit reached/i

export function limitNotice(entry: any): string | null {
  if (entry?.isApiErrorMessage !== true) return null
  const content = entry.message?.content
  const text = Array.isArray(content) ? content.find((b: any) => b?.type === 'text')?.text : undefined
  return typeof text === 'string' && LIMIT_NOTICE.test(text) ? text : null
}

interface CostBucket {
  sessions: Set<string>
  cost: number
}

interface ProjectBucket extends CostBucket, RepoIdentity {
  cacheReadTokens: number
  branches: Map<string, CostBucket>
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
  // Keyed by notice text: one limit is echoed into every session resumed
  // before it resets, and the text carries the reset time.
  limitNotices: Set<string>
  claudeVersions: Record<string, number>
  entrypointCounts: Record<string, number>
  skillCounts: Record<string, number>
  sidechainMessages: number
  permissionModeCounts: Record<string, number>
}

function tally(counts: Record<string, number>, key: unknown): void {
  if (typeof key === 'string' && key) counts[key] = (counts[key] ?? 0) + 1
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
    limitNotices: new Set(),
    claudeVersions: {},
    entrypointCounts: {},
    skillCounts: {},
    sidechainMessages: 0,
    permissionModeCounts: {},
  }
}

export class CodeburnCollector implements EnrichmentCollector {
  /** Last pass's macOS privacy warning, or null when every repo was readable. */
  repoWarning: string | null = null

  private resolveHost: (host: string) => Promise<string>

  /**
   * `orgId` keys the HMAC on Claude account and org IDs: the same account
   * hashes alike on every device in one BurnWatch org and differently in
   * another. Without it no hashes are sent.
   */
  constructor(
    private roots: string[] = claudeParser.roots(),
    private orgId = '',
    private runner: Run = run,
    private table: PriceTable = loadPriceTable(),
  ) {
    this.resolveHost = sshHostResolver(runner)
  }

  async isAvailable(): Promise<boolean> {
    return this.roots.some((r) => existsSync(r))
  }

  async collect(date: string): Promise<ClaudeEnrichment | null> {
    return (await this.collectRange([date])).get(date) ?? null
  }

  // Single pass over the transcripts claude.ts finds, for all requested dates
  // at once. Requests are the parser's records, deduped on its key, and each is
  // priced on its own, so a project's cost is the sum of its requests.
  async collectRange(dates: string[]): Promise<Map<string, ClaudeEnrichment>> {
    if (dates.length === 0) return new Map()
    const files = claudeFiles(this.roots, [...dates].sort()[0])
    // Skipped lines are counted by UsageCollector; nothing reads these.
    const stats = emptyStats()
    const dateSet = new Set(dates)
    const buckets = new Map<string, DateBucket>()
    const rootCache = new Map<string, string>()
    const idCache = new Map<string, Promise<RepoIdentity>>()
    // session-owner records carry no timestamp, so they are joined to days
    // through sessionId after the pass.
    const owners = new Map<string, { accountUuid?: unknown; organizationUuid?: unknown }>()
    // Claude Code writes one line per content block of a streamed reply, and a
    // resumed or forked session copies earlier lines into its own file. Count
    // each request once by the parser's key, keeping the first line seen, and
    // each tool call once by its tool_use id, since the blocks of one reply sit
    // on different lines.
    const seenRequests = new Set<string>()
    const seenToolUses = new Set<string>()

    for (const file of files) {
      const stat = statSync(file)
      if (stat.size > MAX_FILE_SIZE) {
        console.warn(`[burnwatch][codeburn] skipping large file (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${file}`)
        continue
      }

      try {
        for await (const line of claudeLines(file, stats)) {
          const entry = line as any

          if (entry.type === 'session-owner') {
            if (typeof entry.sessionId === 'string') owners.set(entry.sessionId, entry)
            continue
          }

          const date = utcTimestamp(entry.timestamp ?? entry.message?.timestamp, stats)?.slice(0, 10)
          if (!date || !dateSet.has(date)) continue

          if (!buckets.has(date)) buckets.set(date, newBucket())
          const b = buckets.get(date)!

          // Only prompts carry it; tool results do not.
          if (entry.type === 'user') tally(b.permissionModeCounts, entry.permissionMode)

          if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
            const content = entry.message.content ?? []
            for (const block of content) {
              if (block.type !== 'tool_use') continue
              if (typeof block.id === 'string' && block.id) {
                if (seenToolUses.has(block.id)) continue
                seenToolUses.add(block.id)
              }
              const toolName = (block.name ?? '').toLowerCase()
              if (toolName === 'bash') {
                // Basename: a command run by absolute path would carry the user's folders.
                const cmd = (block.input?.command ?? '').trim().split(/\s+/)[0].split(/[\\/]/).pop()
                if (cmd) b.shellUsage[cmd] = (b.shellUsage[cmd] ?? 0) + 1
              } else if (toolName.startsWith('mcp__') || (block.name ?? '').startsWith('mcp__')) {
                const server = (block.name ?? '').split('__')[1] ?? ''
                if (server) b.mcpUsage[server] = (b.mcpUsage[server] ?? 0) + 1
              } else {
                b.toolUsage[toolName] = (b.toolUsage[toolName] ?? 0) + 1
              }
            }

            // Limit notices are synthetic lines with no request behind them.
            const notice = limitNotice(entry)
            if (notice) b.limitNotices.add(notice)

            const rec = claudeRecord(entry, stats)
            if (!rec || seenRequests.has(rec.key)) continue
            seenRequests.add(rec.key)

            b.callCount++

            const sessionId: string = entry.sessionId ?? entry.session_id ?? ''
            if (sessionId) b.sessions.add(sessionId)

            b.inputTokens += rec.input
            b.outputTokens += rec.output
            b.cacheCreateTokens += rec.cacheWrite5m + rec.cacheWrite1h
            b.cacheReadTokens += rec.cacheRead
            // An unpriced model adds nothing; its tokens show in the usage events.
            const cost = priceRecord(this.table, rec) ?? 0

            tally(b.claudeVersions, entry.version)
            tally(b.entrypointCounts, entry.entrypoint)
            tally(b.skillCounts, entry.attributionSkill)
            if (entry.isSidechain === true) b.sidechainMessages++

            const cwd: string = entry.cwd ?? ''
            if (cwd) {
              const root = projectRoot(cwd, rootCache)
              let id = idCache.get(root)
              if (!id) {
                id = repoIdentity(root, this.runner, this.resolveHost)
                idCache.set(root, id)
              }
              const { name, remote } = await id
              // Keyed by remote, so two clones of one repo are one project.
              const key = remote ?? name
              let p = b.projects.get(key)
              if (!p) {
                p = { name, remote, sessions: new Set(), cost: 0, cacheReadTokens: 0, branches: new Map() }
                b.projects.set(key, p)
              }
              if (sessionId) p.sessions.add(sessionId)
              p.cost += cost
              p.cacheReadTokens += rec.cacheRead

              // A detached HEAD names no branch.
              const branch = typeof entry.gitBranch === 'string' ? entry.gitBranch.slice(0, 200) : ''
              if (branch && branch !== 'HEAD') {
                let br = p.branches.get(branch)
                if (!br) {
                  br = { sessions: new Set(), cost: 0 }
                  p.branches.set(branch, br)
                }
                if (sessionId) br.sessions.add(sessionId)
                br.cost += cost
              }
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    this.repoWarning = await deniedWarning(idCache.values())
    if (this.repoWarning) console.warn(`[burnwatch][repo] ${this.repoWarning}`)

    const result = new Map<string, ClaudeEnrichment>()
    for (const [date, b] of buckets) {
      // A day blocked by a limit has notices but no requests; it still counts.
      if (b.callCount === 0 && b.limitNotices.size === 0) continue

      const readable = b.inputTokens + b.cacheCreateTokens + b.cacheReadTokens
      const hashes = (field: 'accountUuid' | 'organizationUuid') => {
        if (!this.orgId) return []
        const ids = new Set<string>()
        for (const s of b.sessions) {
          const raw = owners.get(s)?.[field]
          if (typeof raw === 'string' && raw) ids.add(createHmac('sha256', this.orgId).update(raw).digest('hex'))
        }
        return [...ids].slice(0, 20)
      }

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
        projectBreakdown: Array.from(b.projects.values()).map((p) => {
          const cost = p.cost
          const sessions = p.sessions.size
          return {
            path: p.name,
            remote: p.remote,
            branches: Array.from(p.branches, ([name, br]) => ({ name, cost: br.cost, sessions: br.sessions.size }))
              .sort((x, y) => y.cost - x.cost)
              .slice(0, 50),
            cost,
            sessions,
            avgPerSession: sessions > 0 ? cost / sessions : 0,
            overheadK: p.cacheReadTokens / 1000,
          }
        }),
        toolUsage: b.toolUsage,
        shellUsage: b.shellUsage,
        mcpUsage: b.mcpUsage,
        limitHitCount: b.limitNotices.size,
        claudeVersions: b.claudeVersions,
        entrypointCounts: b.entrypointCounts,
        skillCounts: b.skillCounts,
        sidechainMessages: b.sidechainMessages,
        permissionModeCounts: b.permissionModeCounts,
        accountHashes: hashes('accountUuid'),
        claudeOrgHashes: hashes('organizationUuid'),
      })
    }
    return result
  }
}
