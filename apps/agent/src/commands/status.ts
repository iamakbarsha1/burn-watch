import { hasConfig, loadConfig } from '../lib/config.js'
import { ReferenceCollector } from '../collectors/reference.js'
import { CodeburnCollector } from '../collectors/codeburn.js'
import { isScheduleInstalled } from '../lib/cron.js'
import { AGENT_VERSION } from '../version.js'

export async function statusCommand() {
  if (!hasConfig()) {
    console.log('[burnwatch] Not registered. Run: burnwatch register')
    return
  }

  const config = loadConfig()
  const usage = new ReferenceCollector(config.npxPath ?? 'npx')
  const codeburn = new CodeburnCollector()

  console.log('[burnwatch] Status')
  console.log('  Version:  ', AGENT_VERSION)
  console.log('  Device ID:', config.deviceId)
  console.log('  API URL:  ', config.apiUrl)
  console.log('  Last sync:', config.lastSyncAt ?? 'never')
  console.log('  Schedule: ', isScheduleInstalled() ? 'installed (6 PM daily)' : 'not installed')
  console.log('  Usage:    ', await usage.isAvailable() ? 'available' : 'not available')
  console.log('  codeburn: ', await codeburn.isAvailable() ? 'available' : 'not available')
  // From the last sync, not probed here: a shell has its own privacy grant, so
  // it can read ~/Desktop when the scheduled job cannot.
  if (config.repoAccessWarning) console.log('  Repos:    ', `last sync: ${config.repoAccessWarning}`)
}
