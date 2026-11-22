import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHmac } from 'crypto'
import { CodeburnCollector, deniedWarning } from './codeburn.js'

// `fs` exports are not configurable under ESM, so `vi.spyOn` cannot touch them.
// This wraps the two functions the size guard sits between instead: `statSync`
// can be made to report an oversized file, and `createReadStream` records
// whether the collector opened it anyway.
// `denyUnder` makes `statSync` fail with EPERM below a folder, the way macOS
// privacy (TCC) answers a launchd job reading ~/Desktop.
const fsControl = vi.hoisted(() => ({ fakeSize: null as number | null, readCalls: 0, denyUnder: null as string | null }))

vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>()
  return {
    ...actual,
    statSync: (path: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
      if (fsControl.denyUnder && String(path).startsWith(fsControl.denyUnder)) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      }
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

const toolUse = (name: string, input: Record<string, unknown> = {}, id?: string) => ({
  type: 'tool_use',
  ...(id ? { id } : {}),
  name,
  input,
})

// One line of a streamed reply. Claude Code writes a line per content block,
// each repeating the message id, request id and the full usage.
function streamed(opts: {
  msg?: string
  req?: string
  session: string
  cwd: string
  block: unknown
  input?: number
  output?: number
  cacheCreate?: number
  cacheRead?: number
}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: `${DATE}T10:00:00.000Z`,
    sessionId: opts.session,
    cwd: opts.cwd,
    ...(opts.req ? { requestId: opts.req } : {}),
    message: {
      ...(opts.msg ? { id: opts.msg } : {}),
      role: 'assistant',
      content: [opts.block],
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
  })
}

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
  fsControl.denyUnder = null
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

    const alpha = enrichment?.projectBreakdown.find((p) => p.path === 'alpha')
    const beta = enrichment?.projectBreakdown.find((p) => p.path === 'beta')

    // alpha holds 2600 of 3000 tokens, so it carries 2600/3000 of the $30.
    expect(alpha?.cost).toBeCloseTo(26, 10)
    expect(beta?.cost).toBeCloseTo(4, 10)
    // The split is exhaustive: the parts add back up to what the reference collector reported.
    expect((alpha?.cost ?? 0) + (beta?.cost ?? 0)).toBeCloseTo(30, 10)

    expect(alpha?.sessions).toBe(2)
    expect(alpha?.avgPerSession).toBeCloseTo(13, 10)
    expect(alpha?.overheadK).toBe(2)
    expect(beta?.overheadK).toBe(0)
  })

  it('reports no cost rather than a priced guess when the reference collector gave none', async () => {
    writeSession('a.jsonl', [turn({ session: 's1', cwd: '/work/alpha', input: 100 })])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.projectBreakdown).toEqual([
      { path: 'alpha', remote: null, branches: [], cost: 0, sessions: 1, avgPerSession: 0, overheadK: 0 },
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
    expect(enrichment?.projectBreakdown[0]).toMatchObject({ path: 'repo', remote: null, sessions: 2, cost: 10 })
  })

  it('names a cwd that is in no checkout by its own folder', async () => {
    writeSession('a.jsonl', [turn({ session: 's1', cwd: '/nowhere/at/all', input: 100 })])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.projectBreakdown[0].path).toBe('all')
  })

  it('leaves a turn with no cwd out of the project breakdown but in the day totals', async () => {
    writeSession('a.jsonl', [
      turn({ session: 's1', input: 500 }),
      turn({ session: 's2', cwd: '/work/alpha', input: 500 }),
    ])
    const enrichment = await new CodeburnCollector(root).collect(DATE, 10)
    expect(enrichment?.projectBreakdown.map((p) => p.path)).toEqual(['alpha'])
    // The cwd-less turn still dilutes the share, so alpha gets half, not all.
    expect(enrichment?.projectBreakdown[0].cost).toBeCloseTo(5, 10)
  })
})

// Synthetic copy of the entry Claude Code writes when a usage limit stops a
// turn: an assistant record flagged isApiErrorMessage with the notice as text.
function limitHit(text: string, timestamp = `${DATE}T10:00:00.000Z`) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    isApiErrorMessage: true,
    error: 'rate_limit',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
  })
}

describe('limit-hit counting', () => {
  const SESSION = "You've hit your session limit · resets 3pm (UTC)"

  it('counts current and older notice wordings', async () => {
    writeSession('a.jsonl', [
      limitHit(SESSION),
      limitHit('Claude AI usage limit reached|1762344000'),
      limitHit('5-hour limit reached ∙ resets 3pm'),
    ])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.limitHitCount).toBe(3)
  })

  it('reports zero when no notice matches', async () => {
    writeSession('a.jsonl', [
      assistant([{ type: 'text', text: "You've hit your session limit" }]),
      limitHit('API Error: 500 Internal server error'),
    ])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.limitHitCount).toBe(0)
  })

  it('counts the same notice once per day, even across sessions', async () => {
    writeSession('a.jsonl', [limitHit(SESSION), limitHit(SESSION)])
    writeSession('b.jsonl', [limitHit(SESSION)])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.limitHitCount).toBe(1)
  })

  it('counts the same notice on two days twice', async () => {
    writeSession('a.jsonl', [limitHit(SESSION), limitHit(SESSION, '2026-11-04T10:00:00.000Z')])
    const byDate = await new CodeburnCollector(root).collectRange(['2026-11-04', DATE])
    expect(byDate.get('2026-11-04')?.limitHitCount).toBe(1)
    expect(byDate.get(DATE)?.limitHitCount).toBe(1)
  })

  it('skips malformed lines', async () => {
    writeSession('a.jsonl', ['{"type":"assistant","isApiErrorMessage":true', limitHit(SESSION)])
    const enrichment = await new CodeburnCollector(root).collect(DATE)
    expect(enrichment?.limitHitCount).toBe(1)
  })
})

// Synthetic transcript records for the 0.4 fields. IDs are made up.
describe('streamed duplicate lines', () => {
  const r1 = { msg: 'msg_1', req: 'req_1', session: 's1', cwd: '/work/alpha', input: 100, cacheCreate: 200, cacheRead: 1000, output: 50 }
  const r2 = { msg: 'msg_2', req: 'req_2', session: 's2', cwd: '/work/beta', input: 400, output: 250 }

  it('counts each request once across lines, files and subagent transcripts', async () => {
    writeSession('a.jsonl', [
      streamed({ ...r1, block: { type: 'thinking', thinking: '' } }),
      streamed({ ...r1, block: { type: 'text', text: 'x' } }),
      streamed({ ...r1, block: toolUse('Bash', { command: 'git status' }, 'toolu_1') }),
      streamed({ ...r2, block: { type: 'text', text: 'y' } }),
      streamed({ ...r2, block: toolUse('Read', {}, 'toolu_2') }),
    ])
    // A subagent file that replays the first request and its tool call.
    const sub = join(root, 'my-project', 's1', 'subagents')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'agent-1.jsonl'), streamed({ ...r1, block: toolUse('Bash', { command: 'git status' }, 'toolu_1') }))

    const e = await new CodeburnCollector(root).collect(DATE, 20)

    expect(e?.callCount).toBe(2)
    expect(e?.writtenTokens).toBe(300)
    // 1000 cache reads over 1700 read in, as if each request were one line.
    expect(e?.cacheHitRate).toBeCloseTo((1000 / 1700) * 100, 10)
    expect(e?.sessionCount).toBe(2)

    const alpha = e?.projectBreakdown.find((p) => p.path === 'alpha')
    const beta = e?.projectBreakdown.find((p) => p.path === 'beta')
    // alpha burned 1350 of 2000 tokens, beta 650.
    expect(alpha?.cost).toBeCloseTo(13.5, 10)
    expect(beta?.cost).toBeCloseTo(6.5, 10)
    expect(alpha?.overheadK).toBe(1)
    expect(alpha?.sessions).toBe(1)

    // Tool calls sit on separate lines of one reply: each counts once.
    expect(e?.shellUsage).toEqual({ git: 1 })
    expect(e?.toolUsage).toEqual({ read: 1 })
  })

  it('counts every line that lacks a message id or request id, as before', async () => {
    writeSession('a.jsonl', [
      streamed({ ...r1, req: undefined, block: { type: 'text', text: 'x' } }),
      streamed({ ...r1, req: undefined, block: { type: 'text', text: 'x' } }),
      streamed({ ...r1, msg: undefined, block: { type: 'text', text: 'x' } }),
    ])
    const e = await new CodeburnCollector(root).collect(DATE)
    expect(e?.callCount).toBe(3)
    expect(e?.writtenTokens).toBe(150)
  })
})

const ACCOUNT = '00000000-0000-4000-8000-00000000000a'
const CLAUDE_ORG = '00000000-0000-4000-8000-00000000000b'

function rich(opts: {
  session: string
  cwd?: string
  input?: number
  branch?: string
  version?: string
  entrypoint?: string
  skill?: string
  sidechain?: boolean
  timestamp?: string
}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp ?? `${DATE}T10:00:00.000Z`,
    sessionId: opts.session,
    cwd: opts.cwd,
    gitBranch: opts.branch,
    version: opts.version,
    entrypoint: opts.entrypoint,
    isSidechain: opts.sidechain ?? false,
    ...(opts.skill ? { attributionSkill: opts.skill } : {}),
    message: { role: 'assistant', content: [], usage: { input_tokens: opts.input ?? 0, output_tokens: 0 } },
  })
}

const prompt = (session: string, permissionMode?: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: `${DATE}T09:59:00.000Z`,
    sessionId: session,
    permissionMode,
    message: { role: 'user', content: 'synthetic prompt' },
  })

const owner = (session: string) =>
  JSON.stringify({ type: 'session-owner', sessionId: session, accountUuid: ACCOUNT, organizationUuid: CLAUDE_ORG })

describe('0.4 transcript fields', () => {
  it('counts versions, entry points, skills and sidechain messages per day', async () => {
    writeSession('a.jsonl', [
      rich({ session: 's1', version: '2.1.0', entrypoint: 'cli', skill: 'review' }),
      rich({ session: 's1', version: '2.1.0', entrypoint: 'cli', sidechain: true }),
      rich({ session: 's2', version: '2.2.0', entrypoint: 'sdk-ts', skill: 'review' }),
    ])
    const e = await new CodeburnCollector(root).collect(DATE)
    expect(e?.claudeVersions).toEqual({ '2.1.0': 2, '2.2.0': 1 })
    expect(e?.entrypointCounts).toEqual({ cli: 2, 'sdk-ts': 1 })
    expect(e?.skillCounts).toEqual({ review: 2 })
    expect(e?.sidechainMessages).toBe(1)
  })

  it('reads permission mode from user prompts only', async () => {
    writeSession('a.jsonl', [
      prompt('s1', 'plan'),
      prompt('s1', 'plan'),
      prompt('s1'),
      // A permission-mode record has no timestamp and is not a prompt.
      JSON.stringify({ type: 'permission-mode', sessionId: 's1', permissionMode: 'bypassPermissions' }),
      rich({ session: 's1' }),
    ])
    const e = await new CodeburnCollector(root).collect(DATE)
    expect(e?.permissionModeCounts).toEqual({ plan: 2 })
  })

  it('splits project cost by branch, skipping HEAD and empty branches', async () => {
    writeSession('a.jsonl', [
      rich({ session: 's1', cwd: '/work/alpha', input: 600, branch: 'main' }),
      rich({ session: 's2', cwd: '/work/alpha', input: 300, branch: 'feat/ABC-12' }),
      rich({ session: 's2', cwd: '/work/alpha', input: 50, branch: 'HEAD' }),
      rich({ session: 's2', cwd: '/work/alpha', input: 50, branch: '' }),
    ])
    const e = await new CodeburnCollector(root).collect(DATE, 10)
    const alpha = e!.projectBreakdown[0]
    expect(alpha.branches).toEqual([
      { name: 'main', cost: 6, sessions: 1 },
      { name: 'feat/ABC-12', cost: 3, sessions: 1 },
    ])
    // Branch cost is a part of project cost; the rest is HEAD and unnamed turns.
    const branchSum = alpha.branches!.reduce((sum, b) => sum + b.cost, 0)
    expect(alpha.cost).toBeCloseTo(branchSum + 1, 10)
  })

  it('joins timestamp-less session-owner records to days by sessionId, hashed', async () => {
    writeSession('a.jsonl', [owner('s1'), owner('s2'), rich({ session: 's1' })])
    writeSession('b.jsonl', [rich({ session: 's3' })])
    const e = await new CodeburnCollector(root, 'org-1').collect(DATE)
    const expected = (raw: string) => createHmac('sha256', 'org-1').update(raw).digest('hex')
    expect(e?.accountHashes).toEqual([expected(ACCOUNT)])
    expect(e?.claudeOrgHashes).toEqual([expected(CLAUDE_ORG)])
    // Another BurnWatch org gets a different hash for the same account.
    const other = await new CodeburnCollector(root, 'org-2').collect(DATE)
    expect(other?.accountHashes).not.toEqual(e?.accountHashes)
  })

  it('sends no raw account ID, and no path, anywhere in the payload', async () => {
    const repo = join(root, 'deep', 'checkout')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeSession('a.jsonl', [
      owner('s1'),
      rich({ session: 's1', cwd: repo, input: 10, branch: 'main' }),
      rich({ session: 's1', cwd: '/gone/folder/sub', input: 10 }),
    ])
    const e = await new CodeburnCollector(root, 'org-1', async () => null).collect(DATE, 1)
    const wire = JSON.stringify(e)
    expect(wire).not.toContain(ACCOUNT)
    expect(wire).not.toContain(CLAUDE_ORG)
    expect(wire).not.toContain(root)
    expect(e?.projectBreakdown.map((p) => p.path)).toEqual(['checkout', 'sub'])
    for (const p of e!.projectBreakdown) expect(p.path).not.toMatch(/[\\/]/)
  })

  it('keys a shell command run by absolute path by its basename', async () => {
    writeSession('a.jsonl', [
      assistant([toolUse('Bash', { command: '/opt/tools/bin/deploy --flag' }), toolUse('Bash', { command: 'deploy' })]),
    ])
    const e = await new CodeburnCollector(root).collect(DATE)
    expect(e?.shellUsage).toEqual({ deploy: 2 })
  })

  it('merges two clones of one repo under its remote', async () => {
    for (const clone of ['one', 'two']) mkdirSync(join(root, clone, '.git'), { recursive: true })
    const runner = async (cmd: string) => (cmd === 'git' ? 'git@github.com:Org/Repo.git' : null)
    writeSession('a.jsonl', [
      rich({ session: 's1', cwd: join(root, 'one'), input: 10 }),
      rich({ session: 's2', cwd: join(root, 'two'), input: 10 }),
    ])
    const e = await new CodeburnCollector(root, '', runner).collect(DATE)
    expect(e?.projectBreakdown).toHaveLength(1)
    expect(e?.projectBreakdown[0]).toMatchObject({ path: 'repo', remote: 'github.com/org/repo', sessions: 2 })
    // No orgId, no hashes.
    expect(e?.accountHashes).toEqual([])
  })
})

describe('macOS privacy block', () => {
  it('sends a blocked repo by folder name, without a remote, and warns once', async () => {
    const blocked = join(root, 'Desktop')
    mkdirSync(join(blocked, 'code', 'burn-watch', '.git'), { recursive: true })
    mkdirSync(join(blocked, 'code', 'other', '.git'), { recursive: true })
    writeSession('a.jsonl', [
      turn({ session: 's1', cwd: join(blocked, 'code', 'burn-watch'), input: 10 }),
      turn({ session: 's2', cwd: join(blocked, 'code', 'other'), input: 10 }),
      turn({ session: 's3', cwd: join(blocked, 'code', 'other'), input: 10 }),
    ])
    fsControl.denyUnder = blocked
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const collector = new CodeburnCollector(root, '', async () => 'git@github.com:org/never.git')

    const enrichment = await collector.collect(DATE)

    expect(enrichment!.projectBreakdown.map((p) => [p.path, p.remote]).sort()).toEqual([
      ['burn-watch', null],
      ['other', null],
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/^\[burnwatch\]\[repo\] macOS blocked reading \S+ \(2 repos sent without a remote\)\. Allow "burnwatch"/)
    expect(collector.repoWarning).toContain('Full Disk Access')
  })

  it('says nothing when every repo was readable', async () => {
    writeSession('a.jsonl', [turn({ session: 's1', cwd: root, input: 10 })])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const collector = new CodeburnCollector(root, '', async () => null)
    await collector.collect(DATE)
    expect(warn).not.toHaveBeenCalled()
    expect(collector.repoWarning).toBeNull()
  })

  it('names each blocked folder once', async () => {
    const ids = [
      { name: 'a', remote: null, denied: '~/Desktop' },
      { name: 'b', remote: null, denied: '~/Desktop' },
      { name: 'c', remote: null, denied: '~/Documents' },
      { name: 'd', remote: 'github.com/o/d' },
    ].map((id) => Promise.resolve(id))
    expect(await deniedWarning(ids)).toBe(
      'macOS blocked reading ~/Desktop, ~/Documents (3 repos sent without a remote). ' +
        'Allow "burnwatch" in System Settings > Privacy & Security > Files and Folders (or Full Disk Access).',
    )
  })
})
