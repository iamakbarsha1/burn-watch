import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { AGENT_VERSION } from './version.js'

describe('AGENT_VERSION', () => {
  it('matches the version in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string }
    expect(AGENT_VERSION).toBe(pkg.version)
  })

  it('is a plain semver triple, because release tags are built from it', () => {
    expect(AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
