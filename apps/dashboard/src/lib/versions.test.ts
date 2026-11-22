import { describe, it, expect } from 'vitest'
import type { AdminDeviceRow } from '@burn-watch/shared'
import { deviceVersionStatus, versionSummary } from './versions'

const NOW = new Date('2026-11-22T12:00:00Z')

const row = (over: Partial<AdminDeviceRow> = {}): AdminDeviceRow => ({
  id: 'd1',
  hostname: 'laptop',
  platform: 'darwin',
  lastSeenAt: '2026-11-22T08:00:00Z',
  userName: 'Ada',
  userEmail: 'ada@example.com',
  revoked: false,
  agentVersion: '0.4.0',
  claudeVersion: '2.1.330',
  ...over,
})

describe('deviceVersionStatus', () => {
  it.each([
    ['below the minimum', row({ claudeVersion: '2.0.9' }), '2.1.0', 'below'],
    ['equal to the minimum', row({ claudeVersion: '2.1.0' }), '2.1.0', 'ok'],
    ['above the minimum, numerically', row({ claudeVersion: '2.1.330' }), '2.1.99', 'ok'],
    ['no minimum set', row({ claudeVersion: '0.0.1' }), null, 'ok'],
    ['agent 0.4+ with no Claude Code use', row({ claudeVersion: null }), '2.1.0', 'none'],
    ['an old agent, even with a minimum', row({ agentVersion: '0.2.4', claudeVersion: null }), '2.1.0', 'unknown'],
  ] as const)('%s', (_, r, min, claude) => {
    expect(deviceVersionStatus(r, min).claude).toBe(claude)
  })

  it('flags an agent below 0.4.0, compared as numbers', () => {
    expect(deviceVersionStatus(row({ agentVersion: '0.1.0' }), null).agentOld).toBe(true)
    expect(deviceVersionStatus(row({ agentVersion: '0.4.0' }), null).agentOld).toBe(false)
    expect(deviceVersionStatus(row({ agentVersion: '0.10.0' }), null).agentOld).toBe(false)
  })
})

describe('versionSummary', () => {
  it('counts active devices only, and never counts unknown as below', () => {
    const rows = [
      row({ id: 'ok' }),
      row({ id: 'below', claudeVersion: '2.0.0' }),
      row({ id: 'old', agentVersion: '0.1.0', claudeVersion: null }),
      row({ id: 'none', claudeVersion: null }),
      row({ id: 'revoked', revoked: true, claudeVersion: '1.0.0' }),
      row({ id: 'stale', agentVersion: '0.1.0', claudeVersion: null, lastSeenAt: '2026-11-01T00:00:00Z' }),
      row({ id: 'never', lastSeenAt: null }),
    ]
    expect(versionSummary(rows, '2.1.0', NOW)).toEqual({ active: 4, agentCurrent: 3, below: 1, unknown: 1 })
    expect(versionSummary(rows, null, NOW).below).toBe(0)
  })
})
