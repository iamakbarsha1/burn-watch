import { homedir } from 'os'
import { join } from 'path'
import { writeFileSync, existsSync, unlinkSync } from 'fs'
import { execSync } from 'child_process'

const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', 'com.burnwatch.agent.plist')
const LABEL = 'com.burnwatch.agent'

export function installCron(binaryPath: string): void {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>sync</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>18</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${join(homedir(), '.burnwatch', 'agent.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), '.burnwatch', 'agent-error.log')}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>`

  writeFileSync(PLIST_PATH, plist, 'utf8')
  try {
    execSync(`launchctl load ${PLIST_PATH}`, { stdio: 'pipe' })
  } catch {
    // May fail if already loaded
  }
}

export function uninstallCron(): void {
  if (isCronInstalled()) {
    try { execSync(`launchctl unload ${PLIST_PATH}`, { stdio: 'pipe' }) } catch {}
    unlinkSync(PLIST_PATH)
  }
}

export function isCronInstalled(): boolean {
  return existsSync(PLIST_PATH)
}
