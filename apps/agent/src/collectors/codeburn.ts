import { existsSync, readdirSync, statSync } from 'fs'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { createHmac } from 'crypto'
import type { ClaudeEnrichment } from '@burn-watch/shared'
import type { EnrichmentCollector } from './base.js'
import { probeGit, repoIdentity, run, sshHostResolver, type RepoIdentity, type Run } from './repo.js'

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

interface TokenBucket {
  sessions: Set<string>
  tokens: number
}

interface ProjectBucket extends TokenBucket, RepoIdentity {
  cacheReadTokens: number
  branches: Map<string, TokenBucket>
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
    private claudeDir: string = join(homedir(), '.claude', 'projects'),
    private orgId = '',
    private runner: Run = run,
  ) {
    this.resolveHost = sshHostResolver(runner)
  }

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
    const idCache = new Map<string, Promise<RepoIdentity>>()
    // session-owner records carry no timestamp, so they are joined to days
    // through sessionId after the pass.
    const owners = new Map<string, { accountUuid?: unknown; organizationUuid?: unknown }>()
    // Claude Code writes one line per content block of a streamed reply, each
    // with the same message.id, requestId and usage, and a resumed or forked
    // session copies earlier lines into its own file. Count each request once
    // across the whole run, keeping the first line seen, and each tool call
    // once by its tool_use id, since the blocks of one reply sit on different lines.
    const seenRequests = new Set<string>()
    const seenToolUses = new Set<string>()

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

          if (entry.type === 'session-owner') {
            if (typeof entry.sessionId === 'string') owners.set(entry.sessionId, entry)
            continue
          }

          const ts: string = entry.timestamp ?? entry.message?.timestamp ?? ''
          const date = ts.slice(0, 10)
          if (!dateSet.has(date)) continue

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

            // A line missing either id is counted, as before.
            const msgId = entry.message.id
            const reqId = entry.requestId
            if (typeof msgId === 'string' && msgId && typeof reqId === 'string' && reqId) {
              const key = `${msgId}:${reqId}`
              if (seenRequests.has(key)) continue
              seenRequests.add(key)
            }

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

            const notice = limitNotice(entry)
            if (notice) b.limitNotices.add(notice)

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
                p = { name, remote, sessions: new Set(), tokens: 0, cacheReadTokens: 0, branches: new Map() }
                b.projects.set(key, p)
              }
              const tokens = input + output + cacheCreate + cacheRead
              if (sessionId) p.sessions.add(sessionId)
              p.tokens += tokens
              p.cacheReadTokens += cacheRead

              // A detached HEAD names no branch.
              const branch = typeof entry.gitBranch === 'string' ? entry.gitBranch.slice(0, 200) : ''
              if (branch && branch !== 'HEAD') {
                let br = p.branches.get(branch)
                if (!br) {
                  br = { sessions: new Set(), tokens: 0 }
                  p.branches.set(branch, br)
                }
                if (sessionId) br.sessions.add(sessionId)
                br.tokens += tokens
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
      if (b.callCount === 0) continue

      const readable = b.inputTokens + b.cacheCreateTokens + b.cacheReadTokens
      const dayTokens = readable + b.outputTokens
      const dayCost = claudeCostByDate.get(date) ?? 0
      // ponytail: tokens are a flat weight, so a project on a cheaper model is
      // charged above its real share. Weight by model price if the split ever
      // has to be exact.
      const share = (tokens: number) => (dayTokens > 0 ? dayCost * (tokens / dayTokens) : 0)
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
          const cost = share(p.tokens)
          const sessions = p.sessions.size
          return {
            path: p.name,
            remote: p.remote,
            branches: Array.from(p.branches, ([name, br]) => ({ name, cost: share(br.tokens), sessions: br.sessions.size }))
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
