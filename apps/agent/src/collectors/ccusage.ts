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

  async collect(date: string): Promise<UsageEvent[]> {
    const ccDate = date.replace(/-/g, '')

    let result: { stdout: string; stderr: string; exitCode: number }
    try {
      result = await runCommand(
        this.npxPath,
        ['ccusage@latest', 'daily', '--json', '--since', ccDate, '--until', ccDate],
        60_000,
      )
    } catch (err: any) {
      console.error('[burnwatch][ccusage] spawn error:', err.message)
      return []
    }

    if (result.exitCode !== 0) {
      console.error('[burnwatch][ccusage] exit', result.exitCode, result.stderr)
      return []
    }

    let output: CcusageOutput
    try {
      output = JSON.parse(result.stdout)
    } catch {
      console.error('[burnwatch][ccusage] failed to parse JSON:', result.stdout.slice(0, 200))
      return []
    }

    if (!output.daily || !Array.isArray(output.daily)) {
      console.error('[burnwatch][ccusage] unexpected format: missing daily array')
      return []
    }

    const events: UsageEvent[] = []

    for (const entry of output.daily) {
      const agent = resolveAgent(entry)
      if (!agent) continue

      // Each model breakdown becomes a separate UsageEvent
      if (entry.modelBreakdowns?.length) {
        for (const model of entry.modelBreakdowns) {
          const totalTokens = model.inputTokens + model.outputTokens +
            model.cacheCreationTokens + model.cacheReadTokens
          events.push({
            agent,
            date,
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
        // No model breakdowns — single aggregate event
        events.push({
          agent,
          date,
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
}
