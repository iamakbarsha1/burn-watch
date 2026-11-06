import { Command } from 'commander'
import { registerCommand } from './commands/register.js'
import { syncCommand } from './commands/sync.js'
import { statusCommand } from './commands/status.js'
import { installCron, uninstallCron, SELF_CHECK_COMMAND, SELF_CHECK_SENTINEL } from './lib/cron.js'
import { DEFAULT_API_URL, hasConfig, loadConfig, deleteConfig } from './lib/config.js'
import { ApiClient } from './lib/api.js'

const program = new Command()
  .name('burnwatch')
  .description('AI token usage sync agent for BurnWatch dashboard')
  .version('0.1.0')

program
  .command('register')
  .description('Register this device with BurnWatch')
  .option('--api-url <url>', 'BurnWatch API URL', DEFAULT_API_URL)
  .action(registerCommand)

program
  .command('sync')
  .description('Sync AI usage data to BurnWatch dashboard')
  .option('--date <date>', 'Sync specific date (YYYY-MM-DD)')
  .option('--last-7', 'Backfill last 7 days')
  .option('--days <n>', 'Backfill last N days')
  .action(syncCommand)

program
  .command('status')
  .description('Show agent status and last sync info')
  .action(statusCommand)

program
  .command('install-cron')
  .description('Install or repoint the launchd daily sync at this build')
  .action(() => {
    uninstallCron()
    const scheduled = installCron()
    if (!scheduled) {
      console.error('[burnwatch] This build cannot re-invoke itself — nothing scheduled.')
      process.exit(1)
    }
    console.log('[burnwatch] Scheduled daily sync at 6 PM (launchd):', scheduled.join(' '))
  })

program
  .command('uninstall')
  .description('Remove launchd cron and revoke device token')
  .action(async () => {
    uninstallCron()

    // The local config is deleted whatever the API says. Leaving a usable
    // token on a machine being uninstalled is the thing this command exists to
    // prevent, and a server that cannot be reached is not a reason to keep it.
    if (hasConfig()) {
      try {
        const config = loadConfig()
        await new ApiClient(config.apiUrl, config.accessToken).revokeDevice()
        console.log('[burnwatch] Device token revoked.')
      } catch {
        console.error(
          '[burnwatch] Could not revoke the device token. Revoke this device from the dashboard.',
        )
      }
      deleteConfig()
    }

    console.log('[burnwatch] Uninstalled. Config removed from ~/.burnwatch/config.json')
  })

// How installCron tells a burnwatch build apart from the runtime hosting it.
program
  .command(SELF_CHECK_COMMAND, { hidden: true })
  .description('Print a sentinel proving this invocation reaches burnwatch')
  .action(() => {
    console.log(SELF_CHECK_SENTINEL)
  })

program.parse(process.argv)
