import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { tokenMatchesHash } from './invites.js'

describe('invite token hashing', () => {
  it('matches a token against its own hash', () => {
    const token = 'kP3_nQ8yR1tV7wX2zA5bC9dE0fG4hJ6k'
    expect(tokenMatchesHash(token, createHash('sha256').update(token).digest('hex'))).toBe(true)
  })

  it('rejects a different token', () => {
    const hash = createHash('sha256').update('real-token').digest('hex')
    expect(tokenMatchesHash('other-token', hash)).toBe(false)
  })

  it('rejects a hash of the wrong length instead of throwing', () => {
    // timingSafeEqual throws on length mismatch, so the length is checked first.
    expect(() => tokenMatchesHash('t', 'abcd')).not.toThrow()
    expect(tokenMatchesHash('t', 'abcd')).toBe(false)
  })
})
