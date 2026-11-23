import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { formatShape, readShape } from './shape.js'

let root: string | null = null
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = null
})

describe('dump-shape', () => {
  it('prints key paths, counts and types, never values or data-like keys', async () => {
    root = mkdtempSync(join(tmpdir(), 'burnwatch-shape-'))
    mkdirSync(join(root, 'a'))
    const secret = 'SECRET-PROMPT-TEXT'
    writeFileSync(
      join(root, 'a', 's.jsonl'),
      [
        JSON.stringify({ type: 'assistant', usage: { input: 5, output: 7 }, content: [{ text: secret }] }),
        JSON.stringify({ type: 'user', files: { '/Users/me/secret.ts': 1 }, inputs: { toolu_01RG1Rp14Gaw: { cmd: 1 } } }),
        'not json',
      ].join('\n'),
    )
    writeFileSync(join(root, 'a', 'x.zst'), 'binary')
    writeFileSync(join(root, 'session.json'), JSON.stringify({ messages: [{ tokens: { input: 1 } }] }))

    const s = await readShape([root, join(root, 'missing')])
    const out = formatShape('claude', [root, join(root, 'missing')], s).join('\n')

    expect(out).not.toContain(secret)
    expect(out).not.toContain('/Users/me')
    expect(out).toContain('files.<key>')
    expect(out).not.toContain('toolu_01')
    expect(out).toContain('inputs.<key>.cmd')
    expect(out).toMatch(/usage\.input\s+1\s+number/)
    expect(out).toMatch(/content\[\]\.text\s+1\s+string/)
    expect(out).toMatch(/messages\[\]\.tokens\.input\s+1\s+number/)
    expect(out).toContain('1/2 log folders found, 2 files read')
    expect(out).toContain('.zst 1')
    expect(s.badLines).toBe(1)
    expect(s.records).toBe(3)
  })
})
