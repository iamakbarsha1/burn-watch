import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { createInterface } from 'readline'
import { homedir } from 'os'
import { extname, join } from 'path'
import type { AgentName } from '@burn-watch/shared'
import { claudeParser } from './parsers/claude.js'

// Temporary: `burnwatch compare --dump-shape <agent>` prints the shape of an
// agent's local logs (key paths, counts, value types) so a parser can be
// written for a machine we cannot see. Never values. Deleted in phase 3.

const MAX_FILE_SIZE = 50 * 1024 * 1024
const MAX_FILES = 500
// A key that is not a plain identifier may be data (a path, an id, a prompt).
// Ids (toolu_01..., uuids) carry digit runs; field names do not.
const SAFE_KEY = /^(?!.*\d{2})[A-Za-z_][A-Za-z0-9_]{0,39}$/
// An object this wide is a map keyed by data, not a record.
const MAP_KEYS = 40
// Usage sits within four levels in every known format; deeper is tool schemas and payloads.
const MAX_DEPTH = 6

const home = (env: string, ...fallback: string[]) => process.env[env]?.trim() || join(homedir(), ...fallback)

/** Where each agent keeps its logs, env override first, as the reference collector reads them. */
export function shapeRoots(agent: AgentName): string[] {
  switch (agent) {
    case 'claude':
      return claudeParser.roots()
    case 'codex': {
      const dir = home('CODEX_HOME', '.codex')
      return [join(dir, 'sessions'), join(dir, 'archived_sessions')]
    }
    case 'gemini':
      return [home('GEMINI_DATA_DIR', '.gemini', 'tmp')]
    case 'qwen':
      return [home('QWEN_DATA_DIR', '.qwen')]
    case 'copilot':
      return [join(home('COPILOT_HOME', '.copilot'), 'session-state')]
  }
}

export type Shape = {
  files: number
  skipped: number // over the size limit or past the file cap
  extensions: Record<string, number>
  records: number
  badLines: number
  paths: Map<string, { count: number; types: Set<string> }>
}

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** Adds one parsed record's key paths and value types. */
export function addShape(shape: Shape, value: unknown, path = '', depth = 0): void {
  const at = path || '$'
  let p = shape.paths.get(at)
  if (!p) shape.paths.set(at, (p = { count: 0, types: new Set() }))
  p.count++
  p.types.add(typeOf(value))
  if (depth >= MAX_DEPTH) return
  if (Array.isArray(value)) {
    for (const item of value) addShape(shape, item, `${path}[]`, depth + 1)
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length > MAP_KEYS) {
      for (const [, v] of entries) addShape(shape, v, `${path}.<map>`, depth + 1)
      return
    }
    for (const [k, v] of entries) addShape(shape, v, `${path}${path ? '.' : ''}${SAFE_KEY.test(k) ? k : '<key>'}`, depth + 1)
  }
}

function logFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) logFiles(full, out)
    else out.push(full)
  }
  return out
}

export async function readShape(roots: string[]): Promise<Shape> {
  const shape: Shape = { files: 0, skipped: 0, extensions: {}, records: 0, badLines: 0, paths: new Map() }
  const files = roots.filter((r) => existsSync(r)).flatMap((r) => logFiles(r))
  for (const file of files) {
    const ext = extname(file) || '(none)'
    shape.extensions[ext] = (shape.extensions[ext] ?? 0) + 1
    if (ext !== '.jsonl' && ext !== '.json') continue
    if (shape.files >= MAX_FILES || statSync(file).size > MAX_FILE_SIZE) {
      shape.skipped++
      continue
    }
    shape.files++
    try {
      if (ext === '.json') {
        addShape(shape, JSON.parse(readFileSync(file, 'utf8')))
        shape.records++
        continue
      }
      const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
      for await (const line of rl) {
        if (!line) continue
        try {
          addShape(shape, JSON.parse(line))
          shape.records++
        } catch {
          shape.badLines++
        }
      }
    } catch {
      shape.badLines++
    }
  }
  return shape
}

export function formatShape(agent: string, roots: string[], s: Shape): string[] {
  const found = roots.filter((r) => existsSync(r)).length
  const lines = [
    `agent ${agent}: ${found}/${roots.length} log folders found, ${s.files} files read, ${s.skipped} skipped, ${s.records} records, ${s.badLines} bad`,
    `file types: ${Object.entries(s.extensions).map(([e, n]) => `${e} ${n}`).join(', ') || 'none'}`,
  ]
  for (const [path, p] of [...s.paths].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${path.padEnd(70)} ${String(p.count).padStart(9)}  ${[...p.types].sort().join('|')}`)
  }
  return lines
}
