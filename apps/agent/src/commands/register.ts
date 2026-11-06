import { hostname } from 'os'
import { createInterface } from 'readline'
import { ApiClient } from '../lib/api.js'
import { saveConfig, backupConfig, configuredApiUrl, DEFAULT_API_URL } from '../lib/config.js'
import { installSchedule, isScheduleInstalled } from '../lib/cron.js'
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
  // Read before anything is written, so the message after verification can say
  // what this machine used to report to rather than what it reports to now.
  const previousApiUrl = configuredApiUrl()

  console.log('[burnwatch] Registering device with', apiUrl)

  if (previousApiUrl && previousApiUrl !== apiUrl) {
    console.log(`[burnwatch] This machine is already registered with ${previousApiUrl}.`)
    console.log('  Completing this registration repoints it. The old config will be backed up.')
  }

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

      // Copy any existing config aside before replacing it. The tokens in it
      // are the only copies anywhere, so overwriting silently is how a laptop
      // stops reporting to the BurnWatch it was already registered with and
      // nobody finds out until the numbers go flat.
      const backup = backupConfig()
      if (backup) {
        console.log()
        console.log('[burnwatch] An existing registration was replaced.')
        if (previousApiUrl && previousApiUrl !== apiUrl) {
          console.log(`  This machine previously reported to ${previousApiUrl}`)
        }
        console.log(`  Previous config saved to ${backup}`)
      }

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

      // Install the daily sync schedule. A dedicated try/catch here, separate
      // from the polling loop's catch below, so a platform that cannot be
      // scheduled on reports clearly instead of being read as "not yet
      // verified" and retried until the 15-minute poll times out.
      try {
        if (!isScheduleInstalled()) {
          const scheduled = installSchedule()
          if (scheduled) {
            console.log('[burnwatch] Scheduled daily sync at 6 PM:', scheduled.join(' '))
          } else {
            console.error('[burnwatch] Could not schedule the daily sync — this build cannot')
            console.error('           re-invoke itself. Run register from the burnwatch binary.')
          }
        }
      } catch (err) {
        console.error(`[burnwatch] Could not schedule the daily sync — ${(err as Error).message}`)
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
