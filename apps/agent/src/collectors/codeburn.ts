import { existsSync, readdirSync, statSync } from 'fs'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { join } from 'path'
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

async function processFile(
  file: string,
  date: string,
  toolUsage: Record<string, number>,
  shellUsage: Record<string, number>,
  mcpUsage: Record<string, number>,
): Promise<{ callCount: number; hasActivity: boolean }> {
  // Skip files larger than threshold
  const stat = statSync(file)
  if (stat.size > MAX_FILE_SIZE) {
    console.warn(`[burnwatch][codeburn] skipping large file (${(stat.size / 1024 / 1024).toFixed(1)}MB): ${file}`)
    return { callCount: 0, hasActivity: false }
  }

  let callCount = 0
  let hasActivity = false

  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line) continue

    let entry: any
    try { entry = JSON.parse(line) } catch { continue }

    // Check if this entry is on target date
    const ts: string = entry.timestamp ?? entry.message?.timestamp ?? ''
    if (!ts.startsWith(date)) continue

    hasActivity = true

    if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
      callCount++
      const content = entry.message.content ?? []
      for (const block of content) {
        if (block.type === 'tool_use') {
          const toolName = (block.name ?? '').toLowerCase()
          if (toolName === 'bash') {
            const cmd = (block.input?.command ?? '').trim().split(/\s+/)[0]
            if (cmd) shellUsage[cmd] = (shellUsage[cmd] ?? 0) + 1
          } else if (toolName.startsWith('mcp__') || (block.name ?? '').startsWith('mcp__')) {
            const server = (block.name ?? '').split('__')[1] ?? ''
            if (server) mcpUsage[server] = (mcpUsage[server] ?? 0) + 1
          } else {
            toolUsage[toolName] = (toolUsage[toolName] ?? 0) + 1
          }
        }
      }
    }
  }

  return { callCount, hasActivity }
}

export class CodeburnCollector implements EnrichmentCollector {
  private claudeDir = join(homedir(), '.claude', 'projects')

  async isAvailable(): Promise<boolean> {
    return existsSync(this.claudeDir)
  }

  async collect(date: string): Promise<ClaudeEnrichment | null> {
    const files = findJsonlFiles(this.claudeDir)
    if (files.length === 0) return null

    let sessionCount = 0
    let callCount = 0
    const toolUsage: Record<string, number> = {}
    const shellUsage: Record<string, number> = {}
    const mcpUsage: Record<string, number> = {}

    for (const file of files) {
      try {
        const result = await processFile(file, date, toolUsage, shellUsage, mcpUsage)
        callCount += result.callCount
        if (result.hasActivity) sessionCount++
      } catch {
        // Skip unreadable files
      }
    }

    if (sessionCount === 0 && callCount === 0) return null

    return {
      date,
      sessionCount,
      callCount,
      cacheHitRate: 0,
      writtenTokens: 0,
      activityBreakdown: [],
      projectBreakdown: [],
      topSessions: [],
      toolUsage,
      shellUsage,
      mcpUsage,
    }
  }
}
