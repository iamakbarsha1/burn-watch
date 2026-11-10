import type { CopilotStatus } from '@burn-watch/shared'

/**
 * What the Copilot panel renders, chosen once rather than re-derived by each
 * branch of the JSX.
 *
 * The panel has four renderings and two of them turn on `encryption`. Picking
 * between them in the markup means nested ternaries no test can reach, and the
 * distinction that matters most is the first one a nested ternary loses: a
 * mistyped key against an absent one.
 */
export type CopilotView =
  /** The status request itself failed. Nothing below is known. */
  | { kind: 'unreachable' }
  /**
   * Encryption is unusable, so no token can be stored or read. `org` carries
   * the connection that already exists, when one does: a key removed from the
   * environment does not delete the row, and saying "not connected" here would
   * be a lie that sends an operator to reconnect instead of to their config.
   */
  | { kind: 'blocked'; reason: 'missing-key' | 'malformed-key'; org: string | null }
  /** Ready and no connection stored. The connect form. */
  | { kind: 'disconnected' }
  /** Ready and connected. */
  | { kind: 'connected'; org: string; lastSyncAt: string | null }

export function copilotView(status: CopilotStatus | null): CopilotView {
  if (!status) return { kind: 'unreachable' }

  if (status.encryption !== 'ready') {
    return {
      kind: 'blocked',
      reason: status.encryption,
      org: status.connected ? status.org : null,
    }
  }

  // `org` is what the panel names, so a connection the API reports without one
  // has nothing to show and is treated as no connection. The API gates `org`
  // on `connected` already; this is the type narrowing that follows from it.
  if (!status.connected || !status.org) return { kind: 'disconnected' }

  return { kind: 'connected', org: status.org, lastSyncAt: status.lastSyncAt }
}

/**
 * The two encryption faults, in the operator's words.
 *
 * A table rather than a branch because the whole point is that these two stay
 * different. One generic "encryption unavailable" would send an operator
 * hunting for a secret that is already set.
 */
export const ENCRYPTION_FAULTS = {
  'missing-key': {
    title: 'COPILOT_ENCRYPTION_KEY is not set',
    detail:
      'The API has no key to encrypt a Copilot token with, so no connection can be stored. Set COPILOT_ENCRYPTION_KEY on the API to the output of "openssl rand -base64 32" and restart it.',
  },
  'malformed-key': {
    title: 'COPILOT_ENCRYPTION_KEY is set but unusable',
    detail:
      'The key is present, so there is nothing to go looking for. Its value is not a base64 encoding of 32 bytes, which is what the API needs. Replace it with the output of "openssl rand -base64 32" and restart the API.',
  },
} as const

/**
 * A sync in one line, for the admin who ran it.
 *
 * Seats and rows are separate counts and are easy to read as one. A seat is a
 * licence GitHub has issued; a row is a developer-day this sync actually
 * recorded, and the two differ whenever a login does not match a user.
 */
export function describeSync(result: {
  day: string
  seats: { total: number; skippedNullAssignee: number }
  usage: { written: number }
}): string {
  const rows = result.usage.written
  return `${result.day}: ${result.seats.total} ${plural(result.seats.total, 'seat')}, ${rows} ${plural(rows, 'row')} written.`
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}
