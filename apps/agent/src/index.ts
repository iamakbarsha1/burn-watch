import { Command } from 'commander'
import { registerCommand } from './commands/register.js'
import { syncCommand } from './commands/sync.js'
import { statusCommand } from './commands/status.js'
import { uninstallCron } from './lib/cron.js'

const program = new Command()
  .name('burnwatch')
  .description('AI token usage sync agent for BurnWatch dashboard')
  .version('0.1.0')

program
  .command('register')
  .description('Register this device with BurnWatch')
  .option('--api-url <url>', 'BurnWatch API URL', 'https://api.burnwatch.com')
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
  .command('uninstall')
  .description('Remove launchd cron and revoke device token')
  .action(async () => {
    uninstallCron()
    console.log('[burnwatch] Uninstalled. Config remains at ~/.burnwatch/config.json')
  })

program.parse(process.argv)
