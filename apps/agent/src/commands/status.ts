import { existsSync } from 'fs'
import { AgentNameSchema } from '@burn-watch/shared'
import { hasConfig, loadConfig } from '../lib/config.js'
import { CodeburnCollector } from '../collectors/codeburn.js'
import { PARSERS } from '../collectors/usage.js'
import { claudeFiles } from '../collectors/parsers/claude.js'
import { loadPriceTable } from '../collectors/pricing.js'
import { isScheduleInstalled } from '../lib/cron.js'
import { AGENT_VERSION } from '../version.js'

/** One line per agent: files found, not found, or not collected (no parser yet). */
export function agentLines(): string[] {
  return AgentNameSchema.options.map((agent) => {
    const parser = PARSERS.find((p) => p.agent === agent)
    if (!parser) return `${agent}: not collected`
    const roots = parser.roots().filter((r) => existsSync(r))
    if (roots.length === 0) return `${agent}: not found`
    // Every transcript ever written; the sync itself reads only recent ones.
    return agent === 'claude' ? `${agent}: ${claudeFiles(roots, '1970-01-01').length} files` : `${agent}: found`
  })
}

export async function statusCommand() {
  if (!hasConfig()) {
    console.log('[burnwatch] Not registered. Run: burnwatch register')
    return
  }

  const config = loadConfig()
  const codeburn = new CodeburnCollector()

  console.log('[burnwatch] Status')
  console.log('  Version:  ', AGENT_VERSION)
  console.log('  Device ID:', config.deviceId)
  console.log('  API URL:  ', config.apiUrl)
  console.log('  Last sync:', config.lastSyncAt ?? 'never')
  console.log('  Schedule: ', isScheduleInstalled() ? 'installed (6 PM daily)' : 'not installed')
  for (const line of agentLines()) console.log('  ' + line)
  console.log('  Prices:   ', loadPriceTable().version)
  console.log('  codeburn: ', await codeburn.isAvailable() ? 'available' : 'not available')
  // From the last sync, not probed here: a shell has its own privacy grant, so
  // it can read ~/Desktop when the scheduled job cannot.
  if (config.repoAccessWarning) console.log('  Repos:    ', `last sync: ${config.repoAccessWarning}`)
}
