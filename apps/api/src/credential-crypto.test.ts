import { describe, it, expect, vi } from 'vitest'
import { credentialCrypto, type SealedCredential } from './credential-crypto.js'

const VALID_KEY = Buffer.alloc(32, 7).toString('base64')

/**
 * Narrows to the branch that has `seal` and `open`, and fails loudly if the
 * key under test was not usable after all. The union is the point of the
 * module, so the tests go through the same check a caller would rather than
 * casting it away and proving nothing.
 */
function usable(key: string = VALID_KEY) {
  const result = credentialCrypto({ COPILOT_ENCRYPTION_KEY: key })
  if (!result.available) throw new Error(`expected a usable key, got ${result.reason}`)
  return result
}

/** Flips one bit of the given envelope segment, leaving the rest intact. */
function tamper(sealed: SealedCredential, segment: number): SealedCredential {
  const parts = sealed.split('.')
  const bytes = Buffer.from(parts[segment], 'base64url')
  bytes[0] ^= 0x01
  parts[segment] = bytes.toString('base64url')
  return parts.join('.')
}

describe('credentialCrypto', () => {
  it('reports a missing key instead of throwing, so the feature degrades', () => {
    expect(credentialCrypto({})).toEqual({ available: false, reason: 'missing-key' })
  })

  it('treats an empty key the same as an unset one', () => {
    expect(credentialCrypto({ COPILOT_ENCRYPTION_KEY: '' })).toEqual({
      available: false,
      reason: 'missing-key',
    })
  })

  it('separates a key that is wrong from a key that is absent', () => {
    const tooShort = Buffer.alloc(16).toString('base64')
    expect(credentialCrypto({ COPILOT_ENCRYPTION_KEY: tooShort })).toEqual({
      available: false,
      reason: 'malformed-key',
    })
  })

  it('rejects a key that is not base64', () => {
    expect(credentialCrypto({ COPILOT_ENCRYPTION_KEY: 'not-base64-at-all!!!' })).toEqual({
      available: false,
      reason: 'malformed-key',
    })
  })

  /**
   * The case a length check alone would wave through. Node drops the `!`
   * instead of refusing it, so this junk decodes to exactly 32 bytes and would
   * otherwise become a working key nobody configured.
   */
  it('rejects junk that lenient decoding still turns into 32 bytes', () => {
    const smuggled = `${VALID_KEY.slice(0, 10)}!${VALID_KEY.slice(10)}`
    expect(Buffer.from(smuggled, 'base64')).toHaveLength(32)
    expect(credentialCrypto({ COPILOT_ENCRYPTION_KEY: smuggled })).toEqual({
      available: false,
      reason: 'malformed-key',
    })
  })

  /**
   * `openssl rand -base64 32` is what the docs tell an operator to run, and it
   * prints a trailing newline. A key that survives generation but dies on
   * paste would read as a broken feature rather than as a typo.
   */
  it('accepts a key carrying the newline openssl leaves on it', () => {
    const result = credentialCrypto({ COPILOT_ENCRYPTION_KEY: `${VALID_KEY}\n` })
    if (!result.available) throw new Error(`expected a usable key, got ${result.reason}`)
    expect(result.open(result.seal('ghp_abc123'))).toBe('ghp_abc123')
  })

  it('treats a whitespace-only key as absent rather than malformed', () => {
    expect(credentialCrypto({ COPILOT_ENCRYPTION_KEY: '   \n' })).toEqual({
      available: false,
      reason: 'missing-key',
    })
  })

  it('reads process.env when no environment is handed to it', async () => {
    const saved = process.env.COPILOT_ENCRYPTION_KEY
    delete process.env.COPILOT_ENCRYPTION_KEY
    try {
      expect(credentialCrypto()).toEqual({ available: false, reason: 'missing-key' })

      // Importing has to be inert with nothing configured. A key read at module
      // scope would throw here, long before any caller got the chance to handle
      // an absent one.
      vi.resetModules()
      await expect(import('./credential-crypto.js')).resolves.toHaveProperty('credentialCrypto')
    } finally {
      if (saved !== undefined) process.env.COPILOT_ENCRYPTION_KEY = saved
    }
  })
})

describe('seal and open', () => {
  it('gives back the secret it was handed', () => {
    const crypto = usable()
    expect(crypto.open(crypto.seal('ghp_abc123'))).toBe('ghp_abc123')
  })

  it('writes a different envelope every time, so no nonce is ever reused', () => {
    const crypto = usable()
    const first = crypto.seal('ghp_abc123')
    const second = crypto.seal('ghp_abc123')
    expect(first).not.toBe(second)
    expect(crypto.open(first)).toBe('ghp_abc123')
    expect(crypto.open(second)).toBe('ghp_abc123')
  })

  it('refuses a credential whose ciphertext was altered', () => {
    const crypto = usable()
    expect(() => crypto.open(tamper(crypto.seal('ghp_abc123'), 3))).toThrow()
  })

  it('refuses a credential whose auth tag was altered', () => {
    const crypto = usable()
    expect(() => crypto.open(tamper(crypto.seal('ghp_abc123'), 2))).toThrow()
  })

  it('refuses a version it does not know', () => {
    const crypto = usable()
    const future = crypto.seal('ghp_abc123').replace(/^v1\./, 'v2.')
    expect(() => crypto.open(future)).toThrow(/v1/)
  })

  it('refuses an envelope that is not four segments', () => {
    const crypto = usable()
    expect(() => crypto.open('v1.aaaa.bbbb')).toThrow(/v1/)
    expect(() => crypto.open('')).toThrow(/v1/)
    expect(() => crypto.open(`${crypto.seal('ghp_abc123')}.extra`)).toThrow(/v1/)
  })

  it('refuses a credential sealed under a different key', () => {
    const sealed = usable().seal('ghp_abc123')
    const other = usable(Buffer.alloc(32, 9).toString('base64'))
    expect(() => other.open(sealed)).toThrow()
  })
})
