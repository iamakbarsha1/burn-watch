import { homedir } from 'os'
import { join } from 'path'
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import type { ScheduleBackend } from './cron.js'

const UNIT_DIR = join(homedir(), '.config', 'systemd', 'user')
const SERVICE_PATH = join(UNIT_DIR, 'burnwatch-sync.service')
const TIMER_PATH = join(UNIT_DIR, 'burnwatch-sync.timer')
const TIMER_UNIT = 'burnwatch-sync.timer'

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/(["\\])/g, '\\$1')}"` : arg
}

export function buildSystemdService(programArguments: string[]): string {
  return `[Unit]
Description=BurnWatch daily usage sync

[Service]
Type=oneshot
ExecStart=${programArguments.map(quoteArg).join(' ')}
`
}

export function buildSystemdTimer(): string {
  return `[Unit]
Description=BurnWatch daily usage sync timer

[Timer]
OnCalendar=*-*-* 18:00:00
Persistent=true

[Install]
WantedBy=timers.target
`
}

export const linuxBackend: ScheduleBackend = {
  install(programArguments) {
    mkdirSync(UNIT_DIR, { recursive: true })
    writeFileSync(SERVICE_PATH, buildSystemdService(programArguments), 'utf8')
    writeFileSync(TIMER_PATH, buildSystemdTimer(), 'utf8')
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' })
      execFileSync('systemctl', ['--user', 'enable', '--now', TIMER_UNIT], { stdio: 'pipe' })
    } catch {
      // ponytail: no user D-Bus session (common over a bare SSH shell without
      // lingering enabled) fails the enable step even though the unit files
      // are correct. Upgrade: shell out to `loginctl enable-linger` first, or
      // surface this specific failure instead of swallowing it, if reviewers
      // report timers that never fire.
    }
  },
  uninstall() {
    if (!existsSync(TIMER_PATH)) return
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', TIMER_UNIT], { stdio: 'pipe' })
    } catch {}
    unlinkSync(TIMER_PATH)
    if (existsSync(SERVICE_PATH)) unlinkSync(SERVICE_PATH)
  },
  isInstalled() {
    return existsSync(TIMER_PATH)
  },
}
