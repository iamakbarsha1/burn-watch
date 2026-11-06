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

// An assistant turn carrying the fields the enrichment maths reads: which
// session and project it belongs to, and what it burned.
function turn(opts: {
  session: string
  cwd?: string
  input?: number
  output?: number
  cacheCreate?: number
  cacheRead?: number
  timestamp?: string
}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp ?? `${DATE}T10:00:00.000Z`,
    sessionId: opts.session,
    cwd: opts.cwd,
    message: {
      role: 'assistant',
      content: [],
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
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

  it('counts distinct sessions, not turns', async () => {
    writeSession('a.jsonl', [
      turn({ session: 's1' }),
      turn({ session: 's1' }),
      turn({ session: 's2' }),
    ])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.callCount).toBe(3)
    expect(enrichment?.sessionCount).toBe(2)
  })

  it('reads cache hit rate and written tokens off the usage block', async () => {
    writeSession('a.jsonl', [
      turn({ session: 's1', input: 100, cacheCreate: 300, cacheRead: 600, output: 50 }),
    ])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    // Hit rate is cache reads over everything read in: 600 / (100 + 300 + 600).
    expect(enrichment?.cacheHitRate).toBe(60)
    // Written tokens are output only, so the 1000 read in must not leak here.
    expect(enrichment?.writtenTokens).toBe(50)
  })

  it('groups projects by cwd and splits the day cost by token share', async () => {
    writeSession('a.jsonl', [
      turn({ session: 's1', cwd: '/work/alpha', input: 300, cacheRead: 2000 }),
      turn({ session: 's2', cwd: '/work/alpha', input: 300 }),
      turn({ session: 's3', cwd: '/work/beta', input: 400 }),
    ])
    const enrichment = await new CodeburnCollector(root).collect(DATE, 30)

    const alpha = enrichment?.projectBreakdown.find((p) => p.path === '/work/alpha')
    const beta = enrichment?.projectBreakdown.find((p) => p.path === '/work/beta')

    // alpha holds 2600 of 3000 tokens, so it carries 2600/3000 of the $30.
    expect(alpha?.cost).toBeCloseTo(26, 10)
    expect(beta?.cost).toBeCloseTo(4, 10)
    // The split is exhaustive: the parts add back up to what ccusage reported.
    expect((alpha?.cost ?? 0) + (beta?.cost ?? 0)).toBeCloseTo(30, 10)

    expect(alpha?.sessions).toBe(2)
    expect(alpha?.avgPerSession).toBeCloseTo(13, 10)
    expect(alpha?.overheadK).toBe(2)
    expect(beta?.overheadK).toBe(0)
  })

  it('reports no cost rather than a priced guess when ccusage gave none', async () => {
    writeSession('a.jsonl', [turn({ session: 's1', cwd: '/work/alpha', input: 100 })])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.projectBreakdown).toEqual([
      { path: '/work/alpha', cost: 0, sessions: 1, avgPerSession: 0, overheadK: 0 },
    ])
  })

  it('groups subdirectories of one checkout under its git root', async () => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'apps', 'api'), { recursive: true })
    writeSession('a.jsonl', [
      turn({ session: 's1', cwd: repo, input: 100 }),
      turn({ session: 's2', cwd: join(repo, 'apps', 'api'), input: 100 }),
    ])
    const enrichment = await new CodeburnCollector(root).collect(DATE, 10)
    expect(enrichment?.projectBreakdown).toHaveLength(1)
    expect(enrichment?.projectBreakdown[0]).toMatchObject({ path: repo, sessions: 2, cost: 10 })
  })

  it('keeps a cwd that is in no checkout as it is', async () => {
    writeSession('a.jsonl', [turn({ session: 's1', cwd: '/nowhere/at/all', input: 100 })])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.projectBreakdown[0].path).toBe('/nowhere/at/all')
  })

  it('leaves a turn with no cwd out of the project breakdown but in the day totals', async () => {
    writeSession('a.jsonl', [
      turn({ session: 's1', input: 500 }),
      turn({ session: 's2', cwd: '/work/alpha', input: 500 }),
    ])
    const enrichment = await new CodeburnCollector(root).collect(DATE, 10)
    expect(enrichment?.projectBreakdown.map((p) => p.path)).toEqual(['/work/alpha'])
    // The cwd-less turn still dilutes the share, so alpha gets half, not all.
    expect(enrichment?.projectBreakdown[0].cost).toBeCloseTo(5, 10)
  })
})
