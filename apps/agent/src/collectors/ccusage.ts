import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { UsageEvent, CcusageOutput, CcusageDailyEntry, AgentName } from '@burn-watch/shared'
import type { UsageCollector } from './base.js'

const AGENT_MAP: Record<string, AgentName> = {
  claude: 'claude',
  qwen: 'qwen',
  'gemini cli': 'gemini',
  gemini: 'gemini',
  codex: 'codex',
}

const FREE_TIER_AGENTS = new Set<AgentName>(['qwen'])

function runCommand(cmd: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Command timed out after ${timeout}ms`))
    }, timeout)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        exitCode: code ?? 1,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function resolveAgent(entry: CcusageDailyEntry): AgentName | null {
  // If agent is not 'all', map directly
  if (entry.agent !== 'all') {
    return AGENT_MAP[entry.agent.toLowerCase()] ?? null
  }
  // For 'all' entries, use metadata.agents if available
  const agents = entry.metadata?.agents
  if (agents?.length === 1) {
    return AGENT_MAP[agents[0].toLowerCase()] ?? null
  }
  // Fallback: infer from model names
  const firstModel = entry.modelsUsed?.[0]?.toLowerCase() ?? ''
  if (firstModel.includes('claude')) return 'claude'
  if (firstModel.includes('qwen')) return 'qwen'
  if (firstModel.includes('gemini')) return 'gemini'
  if (firstModel.includes('codex') || firstModel.includes('gpt')) return 'codex'
  return null
}

export class CcusageCollector implements UsageCollector {
  constructor(private npxPath: string = 'npx') {}

  async isAvailable(): Promise<boolean> {
    return (
      existsSync(join(homedir(), '.claude', 'projects')) ||
      existsSync(join(homedir(), '.qwen'))
    )
  }

  private parseOutput(output: CcusageOutput, date: string): UsageEvent[] {
    const events: UsageEvent[] = []
    for (const entry of output.daily) {
      if (entry.period && entry.period !== date) continue
      const agent = resolveAgent(entry)
      if (!agent) continue

      if (entry.modelBreakdowns?.length) {
        for (const model of entry.modelBreakdowns) {
          const totalTokens = model.inputTokens + model.outputTokens +
            model.cacheCreationTokens + model.cacheReadTokens
          events.push({
            agent, date,
            modelName: model.modelName,
            inputTokens: model.inputTokens,
            outputTokens: model.outputTokens,
            cacheCreateTokens: model.cacheCreationTokens,
            cacheReadTokens: model.cacheReadTokens,
            totalTokens,
            costUsd: model.cost,
            isFreeTier: FREE_TIER_AGENTS.has(agent) || model.cost === 0,
          })
        }
      } else {
        events.push({
          agent, date,
          modelName: entry.modelsUsed?.[0] ?? agent,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheCreateTokens: entry.cacheCreationTokens,
          cacheReadTokens: entry.cacheReadTokens,
          totalTokens: entry.totalTokens,
          costUsd: entry.totalCost,
          isFreeTier: FREE_TIER_AGENTS.has(agent) || entry.totalCost === 0,
        })
      }
    }
    return events
  }

  private async runCcusage(since: string, until: string): Promise<CcusageOutput | null> {
    let result: { stdout: string; stderr: string; exitCode: number }
    try {
      result = await runCommand(
        this.npxPath,
        ['ccusage@latest', 'daily', '--json', '--since', since, '--until', until],
        120_000,
      )
    } catch (err: any) {
      console.error('[burnwatch][ccusage] spawn error:', err.message)
      return null
    }
    if (result.exitCode !== 0) {
      console.error('[burnwatch][ccusage] exit', result.exitCode, result.stderr)
      return null
    }
    try {
      return JSON.parse(result.stdout)
    } catch {
      console.error('[burnwatch][ccusage] failed to parse JSON:', result.stdout.slice(0, 200))
      return null
    }
  }

  async collect(date: string): Promise<UsageEvent[]> {
    const ccDate = date.replace(/-/g, '')
    const output = await this.runCcusage(ccDate, ccDate)
    if (!output?.daily) return []
    return this.parseOutput(output, date)
  }

  // Single ccusage call for all dates — O(1) instead of O(N) spawns
  async collectRange(dates: string[]): Promise<Map<string, UsageEvent[]>> {
    if (dates.length === 0) return new Map()
    const sorted = [...dates].sort()
    const since = sorted[0].replace(/-/g, '')
    const until = sorted[sorted.length - 1].replace(/-/g, '')

    const output = await this.runCcusage(since, until)
    const result = new Map<string, UsageEvent[]>()
    if (!output?.daily) return result

    // Group entries by period (date)
    for (const entry of output.daily) {
      const date = entry.period
      if (!date || !dates.includes(date)) continue
      const agent = resolveAgent(entry)
      if (!agent) continue

      if (!result.has(date)) result.set(date, [])
      const events = result.get(date)!

      if (entry.modelBreakdowns?.length) {
        for (const model of entry.modelBreakdowns) {
          const totalTokens = model.inputTokens + model.outputTokens +
            model.cacheCreationTokens + model.cacheReadTokens
          events.push({
            agent, date,
            modelName: model.modelName,
            inputTokens: model.inputTokens,
            outputTokens: model.outputTokens,
            cacheCreateTokens: model.cacheCreationTokens,
            cacheReadTokens: model.cacheReadTokens,
            totalTokens,
            costUsd: model.cost,
            isFreeTier: FREE_TIER_AGENTS.has(agent) || model.cost === 0,
          })
        }
      } else {
        events.push({
          agent, date,
          modelName: entry.modelsUsed?.[0] ?? agent,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheCreateTokens: entry.cacheCreationTokens,
          cacheReadTokens: entry.cacheReadTokens,
          totalTokens: entry.totalTokens,
          costUsd: entry.totalCost,
          isFreeTier: FREE_TIER_AGENTS.has(agent) || entry.totalCost === 0,
        })
      }
    }
    return result
  }
}
