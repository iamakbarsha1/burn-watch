import { homedir } from 'os'
import { join } from 'path'
import { writeFileSync, existsSync, unlinkSync } from 'fs'
import { execFileSync } from 'child_process'

const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', 'com.burnwatch.agent.plist')
const LABEL = 'com.burnwatch.agent'

/**
 * Hidden command that prints SELF_CHECK_SENTINEL. The only way to tell a
 * burnwatch build from the runtime that happens to be hosting it is to run the
 * candidate and see whether burnwatch answers.
 */
export const SELF_CHECK_COMMAND = '__self-check'
export const SELF_CHECK_SENTINEL = 'burnwatch:self-check:ok'

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function buildPlist(programArguments: string[]): string {
  const args = programArguments.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>18</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(homedir(), '.burnwatch', 'agent.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(homedir(), '.burnwatch', 'agent-error.log'))}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>`
}

function answersSelfCheck(argv: string[]): boolean {
  try {
    const out = execFileSync(argv[0], [...argv.slice(1), SELF_CHECK_COMMAND], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.includes(SELF_CHECK_SENTINEL)
  } catch {
    return false
  }
}

/**
 * The argv that re-invokes this program, proven by running it.
 *
 * `process.execPath` is the burnwatch binary only in a `bun build --compile`
 * build. Run from source it is the bun runtime, and `process.argv[1]` holds
 * the entry script — but in a compiled build that slot holds a virtual
 * `/$bunfs/` path that `existsSync` still reports as a real file, so neither
 * value can be trusted on its own. Both shapes are tried and the one that
 * answers wins.
 */
export function resolveSelfCommand(
  runtime: string = process.execPath,
  entry: string | undefined = process.argv[1],
  probe: (argv: string[]) => boolean = answersSelfCheck,
): string[] | null {
  const candidates = entry ? [[runtime], [runtime, entry]] : [[runtime]]
  return candidates.find(probe) ?? null
}

/** Returns the scheduled argv, or null when this build cannot re-invoke itself. */
export function installCron(): string[] | null {
  const self = resolveSelfCommand()
  if (!self) return null

  const programArguments = [...self, 'sync']
  writeFileSync(PLIST_PATH, buildPlist(programArguments), 'utf8')
  try {
    execFileSync('launchctl', ['load', PLIST_PATH], { stdio: 'pipe' })
  } catch {
    // May fail if already loaded
  }
  return programArguments
}

export function uninstallCron(): void {
  if (isCronInstalled()) {
    try { execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe' }) } catch {}
    unlinkSync(PLIST_PATH)
  }
}

export function isCronInstalled(): boolean {
  return existsSync(PLIST_PATH)
}
