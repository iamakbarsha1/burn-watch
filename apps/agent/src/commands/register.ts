import { hostname } from 'os'
import { createInterface } from 'readline'
import { ApiClient } from '../lib/api.js'
import { saveConfig } from '../lib/config.js'
import { installCron, isCronInstalled } from '../lib/cron.js'
import { execSync } from 'child_process'

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function detectNpxPath(): string {
  try {
    return execSync('which npx', { encoding: 'utf8' }).trim()
  } catch {
    return 'npx'
  }
}

export async function registerCommand(options: { apiUrl?: string }) {
  const apiUrl = options.apiUrl ?? 'https://api.burnwatch.com'

  console.log('[burnwatch] Registering device with', apiUrl)

  const email = await prompt('Enter your work email: ')
  if (!email || !email.includes('@')) {
    console.error('[burnwatch] Invalid email')
    process.exit(1)
  }

  const npxPath = detectNpxPath()

  let response: any
  try {
    response = await ApiClient.registerDevice(apiUrl, {
      email,
      hostname: hostname(),
      platform: process.platform,
      agentVersion: '0.1.0',
    })
  } catch (err: any) {
    console.error('[burnwatch] Registration failed:', err.message)
    console.error('Make sure your admin has added your email to BurnWatch first.')
    process.exit(1)
  }

  saveConfig({
    deviceId: response.deviceId,
    userId: response.userId,
    orgId: response.orgId,
    apiUrl,
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    registeredAt: new Date().toISOString(),
    lastSyncAt: null,
    npxPath,
  })

  console.log('[burnwatch] Device registered successfully')
  console.log('  Device ID:', response.deviceId)

  // Install launchd cron
  if (!isCronInstalled()) {
    const binaryPath = process.execPath  // path to current burnwatch binary
    installCron(binaryPath)
    console.log('[burnwatch] Scheduled daily sync at 6 PM (launchd)')
  }

  console.log('[burnwatch] Run: burnwatch sync --last-7 to backfill the last 7 days')
}
