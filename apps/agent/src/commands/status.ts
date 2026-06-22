import { hasConfig, loadConfig } from '../lib/config.js'
import { CcusageCollector } from '../collectors/ccusage.js'
import { CodeburnCollector } from '../collectors/codeburn.js'
import { isCronInstalled } from '../lib/cron.js'

export async function statusCommand() {
  if (!hasConfig()) {
    console.log('[burnwatch] Not registered. Run: burnwatch register')
    return
  }

  const config = loadConfig()
  const ccusage = new CcusageCollector(config.npxPath ?? 'npx')
  const codeburn = new CodeburnCollector()

  console.log('[burnwatch] Status')
  console.log('  Device ID:', config.deviceId)
  console.log('  API URL:  ', config.apiUrl)
  console.log('  Last sync:', config.lastSyncAt ?? 'never')
  console.log('  Cron:     ', isCronInstalled() ? 'installed (6 PM daily)' : 'not installed')
  console.log('  ccusage:  ', await ccusage.isAvailable() ? 'available' : 'not available')
  console.log('  codeburn: ', await codeburn.isAvailable() ? 'available' : 'not available')
}
