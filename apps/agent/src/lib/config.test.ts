import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// `CONFIG_DIR` is resolved from `homedir()` at module load, so the temp home
// has to exist before the module under test is imported. A hoisted mock is the
// only ordering that works; the directory is created inside the factory for
// the same reason.
const home = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const { join } = require('path') as typeof import('path')
  return mkdtempSync(join(tmpdir(), 'burnwatch-config-'))
})

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => home }
})

const { saveConfig, backupConfig, configuredApiUrl, loadConfig, deleteConfig } = await import(
  './config.js'
)

const CONFIG_PATH = join(home, '.burnwatch', 'config.json')

const config = (apiUrl: string) => ({
  deviceId: 'device-1',
  userId: 'user-1',
  orgId: 'org-1',
  apiUrl,
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  registeredAt: '2026-11-06T00:00:00.000Z',
  lastSyncAt: null,
  npxPath: '/usr/local/bin/npx',
})

beforeEach(() => {
  deleteConfig()
  const dir = join(home, '.burnwatch')
  if (!existsSync(dir)) return // nothing has written here yet
  for (const name of readdirSync(dir).filter((n) => n.includes('.bak-'))) {
    rmSync(join(dir, name), { force: true })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('backupConfig', () => {
  it('returns null and writes nothing when there is no config to lose', () => {
    expect(backupConfig()).toBeNull()
    expect(existsSync(CONFIG_PATH)).toBe(false)
  })

  /**
   * The BW-38 case. `register` overwrites this file, and the tokens inside are
   * the only copies that exist — the server keeps a hash. Reverting the backup
   * makes the previous registration unrecoverable, which is what happened.
   */
  it('preserves the previous registration verbatim', () => {
    saveConfig(config('https://burn-watch-api.vercel.app'))
    const before = readFileSync(CONFIG_PATH, 'utf8')

    const backup = backupConfig()

    expect(backup).not.toBeNull()
    expect(readFileSync(backup!, 'utf8')).toBe(before)
    // The original is left in place; replacing it is the caller's job.
    expect(existsSync(CONFIG_PATH)).toBe(true)
  })

  it('keeps the backup unreadable to other users, since it holds live tokens', () => {
    saveConfig(config('https://burn-watch-api.vercel.app'))
    const backup = backupConfig()!
    expect(statSync(backup).mode & 0o777).toBe(0o600)
  })

  it('does not collide when two registrations happen in the same session', () => {
    saveConfig(config('https://one.example'))
    const first = backupConfig(new Date('2026-11-06T10:00:00.000Z'))!
    saveConfig(config('https://two.example'))
    const second = backupConfig(new Date('2026-11-06T10:00:01.000Z'))!

    expect(first).not.toBe(second)
    expect(JSON.parse(readFileSync(first, 'utf8')).apiUrl).toBe('https://one.example')
    expect(JSON.parse(readFileSync(second, 'utf8')).apiUrl).toBe('https://two.example')
  })

  it('names the backup so it cannot be mistaken for the live config', () => {
    saveConfig(config('https://one.example'))
    const backup = backupConfig()!
    expect(backup).toContain('.bak-')
    expect(backup).not.toBe(CONFIG_PATH)
    // A colon in the timestamp would be illegal on Windows, where the agent
    // also runs since BW-20.
    expect(backup).not.toContain(':')
  })
})

describe('configuredApiUrl', () => {
  it('is null when nothing is registered, rather than throwing', () => {
    expect(configuredApiUrl()).toBeNull()
  })

  it('reports the host the stored registration points at', () => {
    saveConfig(config('https://burn-watch-api.vercel.app'))
    expect(configuredApiUrl()).toBe('https://burn-watch-api.vercel.app')
  })

  it('is null rather than a throw when the file is unreadable garbage', () => {
    saveConfig(config('https://one.example'))
    require('fs').writeFileSync(CONFIG_PATH, 'not json at all', 'utf8')
    expect(configuredApiUrl()).toBeNull()
  })
})

describe('saveConfig', () => {
  it('round-trips and stays private', () => {
    saveConfig(config('https://one.example'))
    expect(loadConfig().apiUrl).toBe('https://one.example')
    expect(statSync(CONFIG_PATH).mode & 0o777).toBe(0o600)
  })
})
