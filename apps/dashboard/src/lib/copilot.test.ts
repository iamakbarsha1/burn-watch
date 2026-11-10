import { describe, it, expect } from 'vitest'
import type { CopilotStatus } from '@burn-watch/shared'
import { copilotView, describeSync, ENCRYPTION_FAULTS } from './copilot'

function status(over: Partial<CopilotStatus> = {}): CopilotStatus {
  return {
    encryption: 'ready',
    connected: false,
    org: null,
    lastSyncAt: null,
    ...over,
  }
}

describe('copilotView', () => {
  it('reads a missing status as unreachable rather than unconfigured', () => {
    // The page catches a failed status fetch to null. Calling that
    // "not connected" would show a connect form for a connection that may
    // already exist, and hide the fact that the API is down.
    expect(copilotView(null)).toEqual({ kind: 'unreachable' })
  })

  it('keeps missing-key and malformed-key apart', () => {
    expect(copilotView(status({ encryption: 'missing-key' }))).toEqual({
      kind: 'blocked',
      reason: 'missing-key',
      org: null,
    })
    expect(copilotView(status({ encryption: 'malformed-key' }))).toEqual({
      kind: 'blocked',
      reason: 'malformed-key',
      org: null,
    })
  })

  it('still names the stored org when the key went missing under it', () => {
    // Reachable: connect while the key is set, then remove it from the
    // environment. The row survives, so the panel has to say so.
    const view = copilotView(
      status({ encryption: 'missing-key', connected: true, org: 'acme-inc' }),
    )
    expect(view).toEqual({ kind: 'blocked', reason: 'missing-key', org: 'acme-inc' })
  })

  it('reports no org on a blocked key with nothing connected', () => {
    const view = copilotView(status({ encryption: 'malformed-key', connected: false, org: 'stale' }))
    expect(view).toEqual({ kind: 'blocked', reason: 'malformed-key', org: null })
  })

  it('offers the connect form when encryption is ready and nothing is stored', () => {
    expect(copilotView(status())).toEqual({ kind: 'disconnected' })
  })

  it('reports connected with the org and the last sync', () => {
    expect(
      copilotView(
        status({ connected: true, org: 'acme-inc', lastSyncAt: '2026-11-09T18:00:00.000Z' }),
      ),
    ).toEqual({ kind: 'connected', org: 'acme-inc', lastSyncAt: '2026-11-09T18:00:00.000Z' })
  })

  it('reports connected with no sync yet', () => {
    expect(copilotView(status({ connected: true, org: 'acme-inc' }))).toEqual({
      kind: 'connected',
      org: 'acme-inc',
      lastSyncAt: null,
    })
  })

  it('falls back to disconnected when connected arrives without an org', () => {
    // Nothing to name, so nothing to render as connected.
    expect(copilotView(status({ connected: true, org: null }))).toEqual({ kind: 'disconnected' })
  })
})

describe('ENCRYPTION_FAULTS', () => {
  /**
   * The guard against someone later folding these into one "encryption
   * unavailable" string. That collapse is the defect: an operator reading it
   * for a malformed key goes hunting for a secret that is already set.
   */
  it('tells the two faults apart', () => {
    expect(ENCRYPTION_FAULTS['missing-key'].title).not.toBe(
      ENCRYPTION_FAULTS['malformed-key'].title,
    )
    expect(ENCRYPTION_FAULTS['missing-key'].detail).not.toBe(
      ENCRYPTION_FAULTS['malformed-key'].detail,
    )
  })

  it('names the environment variable in both', () => {
    expect(ENCRYPTION_FAULTS['missing-key'].title).toContain('COPILOT_ENCRYPTION_KEY')
    expect(ENCRYPTION_FAULTS['missing-key'].detail).toContain('COPILOT_ENCRYPTION_KEY')
    expect(ENCRYPTION_FAULTS['malformed-key'].title).toContain('COPILOT_ENCRYPTION_KEY')
  })

  it('says the key is absent for missing-key and present for malformed-key', () => {
    expect(ENCRYPTION_FAULTS['missing-key'].title).toContain('not set')
    expect(ENCRYPTION_FAULTS['malformed-key'].title).toContain('set but unusable')
    expect(ENCRYPTION_FAULTS['malformed-key'].detail).toContain('present')
  })

  it('gives both a repair the operator can run', () => {
    expect(ENCRYPTION_FAULTS['missing-key'].detail).toContain('openssl rand -base64 32')
    expect(ENCRYPTION_FAULTS['malformed-key'].detail).toContain('openssl rand -base64 32')
  })
})

describe('describeSync', () => {
  /**
   * "0 rows written" reads as nothing is wrong, and for an unpublished day
   * retrying is the entire remedy. GitHub also answers 404 rather than 403
   * for a resource a token cannot see, so the same response covers a token
   * lacking Copilot metrics access; the wording has to point at both.
   */
  it('tells the operator to retry when the report was never published', () => {
    const text = describeSync({
      day: '2026-11-09',
      reportPublished: false,
      seats: { total: 12, skippedNullAssignee: 0 },
      usage: { written: 0 },
    })
    expect(text).toContain('not published')
    expect(text).toContain('Try again later')
    expect(text).toContain('Copilot metrics access')
    expect(text).not.toContain('0 rows written')
  })

  it('counts rows normally when the report was published and simply empty', () => {
    expect(
      describeSync({
        day: '2026-11-09',
        reportPublished: true,
        seats: { total: 4, skippedNullAssignee: 0 },
        usage: { written: 0 },
      }),
    ).toBe('2026-11-09: 4 seats, 0 rows written.')
  })

  it('counts seats and written rows separately', () => {
    expect(
      describeSync({
        day: '2026-11-09',
        seats: { total: 12, skippedNullAssignee: 2 },
        usage: { written: 9 },
      }),
    ).toBe('2026-11-09: 12 seats, 9 rows written.')
  })

  it('says seat and row in the singular', () => {
    expect(
      describeSync({
        day: '2026-11-09',
        seats: { total: 1, skippedNullAssignee: 0 },
        usage: { written: 1 },
      }),
    ).toBe('2026-11-09: 1 seat, 1 row written.')
  })

  it('says zero rows rather than going quiet', () => {
    expect(
      describeSync({
        day: '2026-11-09',
        seats: { total: 4, skippedNullAssignee: 4 },
        usage: { written: 0 },
      }),
    ).toBe('2026-11-09: 4 seats, 0 rows written.')
  })
})
