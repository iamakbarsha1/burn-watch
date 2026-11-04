import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { readFileSync } from 'fs'
import { join } from 'path'

// The collector's parsing lives behind a private method, so the test drives it
// through the real `collect` path and fakes only the process boundary. That
// also covers the `--since`/`--until` date reformatting, which a direct call to
// the parser would miss.
const spawnMock = vi.fn()
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

const { CcusageCollector } = await import('./ccusage.js')

const fixture = readFileSync(
  join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'ccusage-daily.json'),
  'utf8',
)

/** Minimal stand-in for a finished child process emitting `stdout` then closing. */
function fakeChild(stdout: string, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: () => void
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    child.emit('close', exitCode)
  })
  return child
}

beforeEach(() => {
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => fakeChild(fixture))
})

describe('CcusageCollector.collect', () => {
  it('strips dashes from the date for the ccusage CLI', async () => {
    await new CcusageCollector().collect('2026-11-05')
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toEqual([
      'ccusage@latest',
      'daily',
      '--json',
      '--since',
      '20261105',
      '--until',
      '20261105',
    ])
  })

  it('emits one row per model when ccusage reports a breakdown', async () => {
    const events = await new CcusageCollector().collect('2026-11-05')
    const claude = events.filter((e) => e.agent === 'claude')
    expect(claude.map((e) => e.modelName)).toEqual([
      'claude-opus-5',
      'claude-haiku-4-5-20251001',
    ])
    // totalTokens is summed from the four per-model counts, not copied.
    expect(claude[0].totalTokens).toBe(1000 + 700 + 300 + 40000)
  })

  it('maps the "gemini cli" agent label onto the gemini agent', async () => {
    const events = await new CcusageCollector().collect('2026-11-05')
    expect(events.some((e) => e.agent === 'gemini')).toBe(true)
  })

  it('falls back to the model name when the agent label is "all"', async () => {
    const events = await new CcusageCollector().collect('2026-11-05')
    // The "all" row only names gpt-5-codex, which resolves to codex.
    const codex = events.find((e) => e.agent === 'codex')
    expect(codex?.modelName).toBe('gpt-5-codex')
  })

  it('drops entries for agents it does not recognise', async () => {
    const events = await new CcusageCollector().collect('2026-11-05')
    expect(events.some((e) => e.modelName === 'cursor-small')).toBe(false)
  })

  it('drops entries from other dates in the same response', async () => {
    const events = await new CcusageCollector().collect('2026-11-05')
    expect(events.every((e) => e.date === '2026-11-05')).toBe(true)
    expect(events.some((e) => e.costUsd === 1.11)).toBe(false)
  })

  it('marks qwen as free tier', async () => {
    const events = await new CcusageCollector().collect('2026-11-05')
    const qwen = events.find((e) => e.agent === 'qwen')
    expect(qwen?.isFreeTier).toBe(true)
    expect(qwen?.costUsd).toBe(0)
  })

  it('marks a paid agent as free tier only when its cost is zero', async () => {
    const events = await new CcusageCollector().collect('2026-11-05')
    expect(events.find((e) => e.modelName === 'claude-opus-5')?.isFreeTier).toBe(false)
    expect(events.find((e) => e.agent === 'gemini')?.isFreeTier).toBe(false)
  })

  it('returns no events when ccusage exits non-zero', async () => {
    spawnMock.mockImplementation(() => fakeChild('', 1))
    expect(await new CcusageCollector().collect('2026-11-05')).toEqual([])
  })

  it('returns no events when ccusage prints something that is not JSON', async () => {
    spawnMock.mockImplementation(() => fakeChild('npm ERR! could not determine executable'))
    expect(await new CcusageCollector().collect('2026-11-05')).toEqual([])
  })
})

describe('CcusageCollector.collectRange', () => {
  it('spawns once for the whole range, bounded by the first and last date', async () => {
    await new CcusageCollector().collectRange(['2026-11-05', '2026-11-03', '2026-11-04'])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [, args] = spawnMock.mock.calls[0]
    expect(args.slice(-4)).toEqual(['--since', '20261103', '--until', '20261105'])
  })

  it('buckets events by their own period, not by the requested date', async () => {
    const byDate = await new CcusageCollector().collectRange(['2026-11-04', '2026-11-05'])
    expect([...byDate.keys()].sort()).toEqual(['2026-11-04', '2026-11-05'])
    expect(byDate.get('2026-11-04')).toHaveLength(1)
  })

  it('does not spawn at all for an empty date list', async () => {
    const result = await new CcusageCollector().collectRange([])
    expect(result.size).toBe(0)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
