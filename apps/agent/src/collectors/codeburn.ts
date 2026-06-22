import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ClaudeEnrichment } from '@burn-watch/shared'
import type { EnrichmentCollector } from './base.js'

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
      let fileHasActivity = false
      try {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
        for (const line of lines) {
          let entry: any
          try { entry = JSON.parse(line) } catch { continue }

          // Check if this entry is on target date
          const ts: string = entry.timestamp ?? entry.message?.timestamp ?? ''
          if (!ts.startsWith(date)) continue

          fileHasActivity = true

          if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
            callCount++
            const content = entry.message.content ?? []
            for (const block of content) {
              if (block.type === 'tool_use') {
                const toolName = (block.name ?? '').toLowerCase()
                if (toolName === 'bash') {
                  // Try to extract shell command
                  const cmd = (block.input?.command ?? '').trim().split(/\s+/)[0]
                  if (cmd) shellUsage[cmd] = (shellUsage[cmd] ?? 0) + 1
                } else if (toolName.includes('mcp') || (block.name ?? '').includes('__')) {
                  // MCP tool: name format is server__toolname
                  const server = (block.name ?? '').split('__')[0].replace(/^mcp_/, '')
                  if (server) mcpUsage[server] = (mcpUsage[server] ?? 0) + 1
                } else {
                  toolUsage[toolName] = (toolUsage[toolName] ?? 0) + 1
                }
              }
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
      if (fileHasActivity) sessionCount++
    }

    if (sessionCount === 0 && callCount === 0) return null

    return {
      date,
      sessionCount,
      callCount,
      cacheHitRate: 0,    // cannot compute from raw JSONL without pricing data
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
