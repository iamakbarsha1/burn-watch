import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CodeburnCollector } from './codeburn.js'

// `fs` exports are not configurable under ESM, so `vi.spyOn` cannot touch them.
// This wraps the two functions the size guard sits between instead: `statSync`
// can be made to report an oversized file, and `createReadStream` records
// whether the collector opened it anyway.
const fsControl = vi.hoisted(() => ({ fakeSize: null as number | null, readCalls: 0 }))

vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>()
  return {
    ...actual,
    statSync: (path: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
      const stat = (actual.statSync as (...a: unknown[]) => import('fs').Stats)(path, ...rest)
      if (fsControl.fakeSize !== null && String(path).endsWith('.jsonl')) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          size: fsControl.fakeSize,
        })
      }
      return stat
    },
    createReadStream: (...args: unknown[]) => {
      fsControl.readCalls++
      return (actual.createReadStream as (...a: unknown[]) => unknown)(...args)
    },
  }
})

const DATE = '2026-11-05'

function assistant(blocks: unknown[], timestamp = `${DATE}T10:00:00.000Z`) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content: blocks },
  })
}

const toolUse = (name: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  name,
  input,
})

let root: string

function writeSession(name: string, lines: string[]) {
  const dir = join(root, 'my-project')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), lines.join('\n'))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'burnwatch-codeburn-'))
  fsControl.fakeSize = null
  fsControl.readCalls = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('CodeburnCollector', () => {
  it('reports nothing when the projects directory does not exist', async () => {
    const collector = new CodeburnCollector(join(root, 'nope'))
    expect(await collector.isAvailable()).toBe(false)
    expect(await collector.collect(DATE)).toBeNull()
  })

  it('counts assistant turns as calls', async () => {
    writeSession('a.jsonl', [
      assistant([toolUse('Read')]),
      assistant([toolUse('Edit')]),
      JSON.stringify({ type: 'user', timestamp: `${DATE}T10:00:01.000Z` }),
    ])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.callCount).toBe(2)
  })

  it('splits tool, shell and MCP usage into their own buckets', async () => {
    writeSession('a.jsonl', [
      assistant([toolUse('Read'), toolUse('Read')]),
      assistant([toolUse('Bash', { command: '  git status --short' })]),
      assistant([toolUse('mcp__neon__run_sql')]),
    ])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    // Tool names are lowercased on the way into the bucket.
    expect(enrichment?.toolUsage).toEqual({ read: 2 })
    // Shell usage keys on the first word of the command, after trimming.
    expect(enrichment?.shellUsage).toEqual({ git: 1 })
    // MCP usage keys on the server segment of `mcp__<server>__<tool>`.
    expect(enrichment?.mcpUsage).toEqual({ neon: 1 })
    expect(enrichment?.toolUsage.bash).toBeUndefined()
  })

  it('ignores entries from other dates', async () => {
    writeSession('a.jsonl', [
      assistant([toolUse('Read')]),
      assistant([toolUse('Read')], '2026-11-04T10:00:00.000Z'),
    ])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.callCount).toBe(1)
  })

  it('skips malformed lines instead of failing the whole file', async () => {
    writeSession('a.jsonl', [
      '{ not json',
      '',
      assistant([toolUse('Read')]),
    ])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.callCount).toBe(1)
  })

  it('finds JSONL files in nested project directories', async () => {
    const nested = join(root, 'org', 'repo', 'deep')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'session.jsonl'), assistant([toolUse('Read')]))
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.callCount).toBe(1)
  })

  it('skips a file over the 50 MB guard rather than reading it', async () => {
    writeSession('small.jsonl', [assistant([toolUse('Read')])])
    // A real 50 MB fixture would be absurd to commit, so the size is faked at
    // the stat boundary. Asserting that no read happened is what proves the
    // guard short circuits before the stream opens, rather than reading the
    // file and discarding the result.
    fsControl.fakeSize = 51 * 1024 * 1024
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const enrichment = await new CodeburnCollector(root).collect(DATE)

    expect(enrichment).toBeNull()
    expect(fsControl.readCalls).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping large file'))
  })

  it('collects several dates in one pass over the files', async () => {
    writeSession('a.jsonl', [
      assistant([toolUse('Read')]),
      assistant([toolUse('Grep')], '2026-11-04T09:00:00.000Z'),
    ])
    const byDate = await new CodeburnCollector(root).collectRange(['2026-11-04', DATE])
    expect([...byDate.keys()].sort()).toEqual(['2026-11-04', '2026-11-05'])
    expect(byDate.get('2026-11-04')?.toolUsage).toEqual({ grep: 1 })
  })
})
