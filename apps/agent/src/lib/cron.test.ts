import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import {
  resolveSelfCommand,
  buildPlist,
  backendFor,
  darwinBackend,
  uninstallSchedule,
  isScheduleInstalled,
  SELF_CHECK_COMMAND,
  SELF_CHECK_SENTINEL,
} from './cron.js'
import { linuxBackend } from './cron-linux.js'
import { windowsBackend } from './cron-windows.js'

function withPlatform(platform: string, fn: () => void) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

const AGENT_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url))

function bunPath(): string | null {
  try {
    return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

describe('resolveSelfCommand', () => {
  const bun = bunPath()

  it.skipIf(!bun)('rejects the bare runtime and schedules the entry script', () => {
    const resolved = resolveSelfCommand(bun!, AGENT_ENTRY)

    expect(resolved).toEqual([bun, AGENT_ENTRY])

    const out = execFileSync(resolved![0], [...resolved!.slice(1), SELF_CHECK_COMMAND], {
      encoding: 'utf8',
    })
    expect(out).toContain(SELF_CHECK_SENTINEL)
  })

  it('uses the runtime alone when it answers, as a compiled binary does', () => {
    const probe = (argv: string[]) => argv.length === 1
    expect(resolveSelfCommand('/opt/burnwatch', '/$bunfs/root/burnwatch', probe)).toEqual([
      '/opt/burnwatch',
    ])
  })

  it('returns null when nothing answers', () => {
    expect(resolveSelfCommand('/usr/bin/node', '/tmp/entry.ts', () => false)).toBeNull()
  })
})

describe('buildPlist', () => {
  it('writes one string per argument', () => {
    const plist = buildPlist(['/opt/burnwatch', 'sync'])
    expect(plist).toContain('<string>/opt/burnwatch</string>\n    <string>sync</string>')
  })

  it('escapes paths that would otherwise break the XML', () => {
    const plist = buildPlist(['/Users/a&b/burnwatch', 'sync'])
    expect(plist).toContain('<string>/Users/a&amp;b/burnwatch</string>')
  })
})

// backendFor only looks up and returns a backend object here — it never calls
// install/uninstall/isInstalled, so these assertions never touch the real
// launchd/systemd/Task Scheduler state of the machine running the test.
describe('backendFor', () => {
  it('routes darwin, linux and win32 to their own backend', () => {
    expect(backendFor('darwin')).toBe(darwinBackend)
    expect(backendFor('linux')).toBe(linuxBackend)
    expect(backendFor('win32')).toBe(windowsBackend)
  })

  it('fails with a clear message, not a stack trace, for an unsupported platform', () => {
    expect(() => backendFor('sunos')).toThrow(
      "Unsupported platform 'sunos'. BurnWatch scheduling supports macOS, Linux and Windows.",
    )
  })
})

// installSchedule/uninstallSchedule/isScheduleInstalled dispatch through
// backendFor(process.platform). Faking the platform to an unsupported value
// still only reaches backendFor's lookup-and-throw — it never calls a real
// backend's install/uninstall against this machine's actual files or OS
// scheduler, so these are safe to run for real, unlike a faked *supported*
// platform would be.
describe('schedule dispatch on an unsupported platform', () => {
  it('uninstallSchedule propagates the clear backendFor error', () => {
    withPlatform('sunos', () => {
      expect(() => uninstallSchedule()).toThrow(/Unsupported platform 'sunos'/)
    })
  })

  it('isScheduleInstalled reports false instead of throwing', () => {
    withPlatform('sunos', () => {
      expect(isScheduleInstalled()).toBe(false)
    })
  })
})
