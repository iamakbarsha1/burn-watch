import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { UsageEvent, CcusageRow, AgentName } from '@burn-watch/shared'
import type { UsageCollector } from './base.js'

const AGENT_MAP: Record<string, AgentName> = {
  'Claude': 'claude',
  'Qwen': 'qwen',
  'Gemini CLI': 'gemini',
  'Codex': 'codex',
}

// Agents that have free tier (no LiteLLM pricing)
const FREE_TIER_AGENTS = new Set<AgentName>(['qwen'])

export class CcusageCollector implements UsageCollector {
  constructor(private npxPath: string = 'npx') {}

  async isAvailable(): Promise<boolean> {
    return (
      existsSync(join(homedir(), '.claude', 'projects')) ||
      existsSync(join(homedir(), '.qwen'))
    )
  }

  async collect(date: string): Promise<UsageEvent[]> {
    // ccusage date format: YYYYMMDD (no dashes)
    const ccDate = date.replace(/-/g, '')

    const result = spawnSync(
      this.npxPath,
      ['ccusage@latest', 'daily', '--json', '--since', ccDate, '--until', ccDate],
      { encoding: 'utf8', timeout: 60_000 }
    )

    if (result.error) {
      console.error('[burnwatch][ccusage] spawn error:', result.error.message)
      return []
    }

    if (result.status !== 0) {
      console.error('[burnwatch][ccusage] exit', result.status, result.stderr)
      return []
    }

    let rows: CcusageRow[]
    try {
      rows = JSON.parse(result.stdout)
    } catch {
      console.error('[burnwatch][ccusage] failed to parse JSON:', result.stdout.slice(0, 200))
      return []
    }

    return rows
      .filter((r) => r.agent !== 'All' && AGENT_MAP[r.agent])
      .map((r): UsageEvent => {
        const agent = AGENT_MAP[r.agent]!
        return {
          agent,
          date,
          modelName: r.models[0] ?? r.agent.toLowerCase(),
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheCreateTokens: r.cacheCreateTokens,
          cacheReadTokens: r.cacheReadTokens,
          totalTokens: r.totalTokens,
          costUsd: r.costUsd,
          isFreeTier: FREE_TIER_AGENTS.has(agent) || r.costUsd === 0,
        }
      })
  }
}
