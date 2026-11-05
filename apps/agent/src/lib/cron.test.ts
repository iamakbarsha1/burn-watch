import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import {
  resolveSelfCommand,
  buildPlist,
  SELF_CHECK_COMMAND,
  SELF_CHECK_SENTINEL,
} from './cron.js'

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
