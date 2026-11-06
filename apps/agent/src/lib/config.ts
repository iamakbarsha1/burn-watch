import { homedir } from 'os'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
  copyFileSync,
} from 'fs'
import type { DeviceConfig } from '@burn-watch/shared'

const CONFIG_DIR = join(homedir(), '.burnwatch')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

// Where `register` points when `--api-url` is not given. This was
// `https://api.burnwatch.com`, a domain that has never existed, so the default
// path through `burnwatch register` could only ever fail with a DNS error.
export const DEFAULT_API_URL = 'https://burn-watch-api.vercel.app'

export function hasConfig(): boolean {
  return existsSync(CONFIG_PATH)
}

export function loadConfig(): DeviceConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error('Not registered. Run: burnwatch register')
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as DeviceConfig
}

export function saveConfig(config: DeviceConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
  chmodSync(CONFIG_PATH, 0o600)
}

export function deleteConfig(): void {
  rmSync(CONFIG_PATH, { force: true })
}

/**
 * Copies the current config aside, returning the backup path, or null when
 * there was nothing to copy.
 *
 * `register` writes this file unconditionally, and the access and refresh
 * tokens in it are the only copies that exist anywhere — the server stores a
 * hash. Re-registering a machine that already reported somewhere else used to
 * destroy them silently, which is recoverable (register again, have an admin
 * approve) but only by someone who knows it happened. A copy costs nothing and
 * removes the whole failure.
 *
 * The backup inherits 0600 explicitly rather than relying on the copy: it
 * holds live credentials, and `copyFileSync` takes its mode from the process
 * umask when the destination does not already exist.
 */
export function backupConfig(now: Date = new Date()): string | null {
  if (!existsSync(CONFIG_PATH)) return null
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const destination = `${CONFIG_PATH}.bak-${stamp}`
  copyFileSync(CONFIG_PATH, destination)
  chmodSync(destination, 0o600)
  return destination
}

/**
 * The API URL the stored config points at, or null when there is no config.
 * Lets a caller warn about repointing a machine without having to catch the
 * "not registered" throw from `loadConfig`.
 */
export function configuredApiUrl(): string | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    return loadConfig().apiUrl ?? null
  } catch {
    return null
  }
}

export function updateConfig(patch: Partial<DeviceConfig>): void {
  const config = loadConfig()
  saveConfig({ ...config, ...patch })
}
