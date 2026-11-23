import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeParser, claudeRecord } from './claude.js'
import { emptyStats, type UsageRecord } from './types.js'

function assistant(over: Record<string, any> = {}, usage: Record<string, any> = {}) {
  return {
    type: 'assistant',
    timestamp: '2026-11-20T10:00:00.000Z',
    requestId: 'req_1',
    uuid: 'u1',
    ...over,
    message: {
      id: 'msg_1',
      model: 'claude-opus-5-5',
      role: 'assistant',
      ...over.message,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 4000,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
        service_tier: 'standard',
        speed: 'standard',
        ...usage,
      },
    },
  }
}

async function readAll(roots: string[], since: string) {
  const stats = emptyStats()
  const out: UsageRecord[] = []
  for await (const r of claudeParser.read(roots, since, stats)) out.push(r)
  return { out, stats }
}

describe('claudeRecord', () => {
  it('maps usage, the 5m/1h split and the dedupe key', () => {
    expect(claudeRecord(assistant(), emptyStats())).toEqual({
      agent: 'claude',
      model: 'claude-opus-5-5',
      at: '2026-11-20T10:00:00.000Z',
      input: 10,
      output: 20,
      cacheWrite5m: 100,
      cacheWrite1h: 200,
      cacheRead: 4000,
      key: 'msg_1:req_1',
    })
  })

  it('treats every cache write as 5m when cache_creation is missing', () => {
    const r = claudeRecord(assistant({}, { cache_creation: undefined }), emptyStats())
    expect([r?.cacheWrite5m, r?.cacheWrite1h]).toEqual([300, 0])
  })

  it('skips <synthetic> lines and non-assistant entries', () => {
    expect(claudeRecord(assistant({ message: { model: '<synthetic>' } }), emptyStats())).toBeNull()
    expect(claudeRecord({ type: 'user', message: { content: 'hi' } }, emptyStats())).toBeNull()
  })

  it('keys a line missing an id by uuid', () => {
    expect(claudeRecord(assistant({ requestId: undefined }), emptyStats())?.key).toBe('uuid:u1')
  })

  it('reads a timestamp with no zone as UTC and counts it', () => {
    const stats = emptyStats()
    expect(claudeRecord(assistant({ timestamp: '2026-11-20T23:59:59' }), stats)?.at).toBe('2026-11-20T23:59:59.000Z')
    expect(stats.noZone).toBe(1)
  })

  it('normalises an offset timestamp to the UTC day', () => {
    const r = claudeRecord(assistant({ timestamp: '2026-11-21T02:00:00+05:30' }), emptyStats())
    expect(r?.at).toBe('2026-11-20T20:30:00.000Z')
  })

  it('counts a non-standard speed or tier and still returns the record', () => {
    const stats = emptyStats()
    expect(claudeRecord(assistant({}, { speed: 'fast' }), stats)).not.toBeNull()
    expect(stats.nonStandard).toBe(1)
  })
})

describe('claudeParser', () => {
  let dir: string
  const saved = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bw-claude-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  })

  it('takes CLAUDE_CONFIG_DIR as a comma list of config or projects folders', () => {
    process.env.CLAUDE_CONFIG_DIR = '/a/claude, /b/projects'
    expect(claudeParser.roots()).toEqual(['/a/claude/projects', '/b/projects'])
  })

  it('defaults to the XDG and home folders', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    const roots = claudeParser.roots()
    expect(roots).toHaveLength(2)
    expect(roots[0]).toMatch(/\.config[\\/]claude[\\/]projects$/)
    expect(roots[1]).toMatch(/\.claude[\\/]projects$/)
  })

  it('reads nested subagent files, skips bad lines, and skips files older than since', async () => {
    const sub = join(dir, 'proj', 'sess', 'subagents')
    mkdirSync(sub, { recursive: true })
    const main = join(dir, 'proj', 'sess.jsonl')
    writeFileSync(main, [JSON.stringify(assistant()), 'not json', ''].join('\n'))
    writeFileSync(
      join(sub, 'agent-1.jsonl'),
      JSON.stringify(assistant({ isSidechain: true, requestId: 'req_2', message: { id: 'msg_2' } })),
    )
    const old = join(dir, 'proj', 'old.jsonl')
    writeFileSync(old, JSON.stringify(assistant({ requestId: 'req_3' })))
    const longAgo = new Date('2026-11-01T00:00:00Z')
    utimesSync(old, longAgo, longAgo)

    const { out, stats } = await readAll([dir], '2026-11-20')
    expect(out.map((r) => r.key).sort()).toEqual(['msg_1:req_1', 'msg_2:req_2'])
    expect(stats.files).toBe(2)
    expect(stats.badLines).toBe(1)
  })
})
