import { hostname } from 'os'
import { createInterface } from 'readline'
import { ApiClient } from '../lib/api.js'
import { saveConfig, DEFAULT_API_URL } from '../lib/config.js'
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

// Someone has to open the dashboard and type the code, so a tighter poll only
// burns the server's rate-limit budget. Keep this in step with the cap on
// POST /v1/auth/verify-device.
const POLL_INTERVAL = 10_000 // 10 seconds
const POLL_TIMEOUT = 15 * 60 * 1000 // 15 minutes (matches server expiry)

export async function registerCommand(options: { apiUrl?: string }) {
  const apiUrl = options.apiUrl ?? DEFAULT_API_URL

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
  console.log('  Sign in to the BurnWatch dashboard, open Devices, and enter this code.')
  console.log('  Waiting for approval...')

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
