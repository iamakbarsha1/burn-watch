import { spawn } from 'child_process'
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
