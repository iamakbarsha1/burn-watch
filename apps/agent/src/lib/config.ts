import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'fs'
import type { DeviceConfig } from '@burn-watch/shared'

const CONFIG_DIR = join(homedir(), '.burnwatch')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

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

export function updateConfig(patch: Partial<DeviceConfig>): void {
  const config = loadConfig()
  saveConfig({ ...config, ...patch })
}
