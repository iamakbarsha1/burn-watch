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

const POLL_INTERVAL = 3_000 // 3 seconds
const POLL_TIMEOUT = 15 * 60 * 1000 // 15 minutes (matches server expiry)

export async function registerCommand(options: { apiUrl?: string }) {
  const apiUrl = options.apiUrl ?? 'https://api.burnwatch.com'

  console.log('[burnwatch] Registering device with', apiUrl)

  const email = await prompt('Enter your work email: ')
  if (!email || !email.includes('@')) {
    console.error('[burnwatch] Invalid email')
    process.exit(1)
  }

  const npxPath = detectNpxPath()

  // Step 1: Request registration — get verification code
  let pendingId: string
  let code: string
  try {
    const pending = await ApiClient.registerDevice(apiUrl, {
      email,
      hostname: hostname(),
      platform: process.platform,
      agentVersion: '0.1.0',
    })
    pendingId = pending.pendingId
    code = pending.code
  } catch (err: any) {
    console.error('[burnwatch] Registration failed:', err.message)
    console.error('Make sure your admin has added your email to BurnWatch first.')
    process.exit(1)
  }

  console.log()
  console.log('  ┌────────────────────────────────┐')
  console.log(`  │  Verification Code:  ${code}      │`)
  console.log('  └────────────────────────────────┘')
  console.log()
  console.log('  Enter this code in the BurnWatch dashboard to verify your device.')
  console.log('  Waiting for verification...')

  // Step 2: Poll for verification
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL))

    try {
      const response = await ApiClient.verifyDevice(apiUrl, pendingId, code)

      // Verified! Save config
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

      console.log()
      console.log('[burnwatch] Device verified and registered successfully!')
      console.log('  Device ID:', response.deviceId)

      // Install launchd cron
      if (!isCronInstalled()) {
        const binaryPath = process.execPath
        installCron(binaryPath)
        console.log('[burnwatch] Scheduled daily sync at 6 PM (launchd)')
      }

      console.log('[burnwatch] Run: burnwatch sync --last-7 to backfill the last 7 days')
      return
    } catch {
      // Not yet verified or expired — keep polling
    }
  }

  console.error('[burnwatch] Verification timed out (15 minutes). Run `burnwatch register` again.')
  process.exit(1)
}
