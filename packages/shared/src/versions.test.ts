import { describe, it, expect } from 'vitest'
import { compareVersions, highestVersion } from './versions.js'

const sign = (a: string, b: string) => Math.sign(compareVersions(a, b))

describe('compareVersions', () => {
  it('compares each part as a number, not as text', () => {
    expect(sign('2.1.330', '2.1.99')).toBe(1)
    expect(sign('2.10.0', '2.9.9')).toBe(1)
    expect(sign('0.10.0', '0.4.0')).toBe(1)
    expect(sign('0.2.4', '0.4.0')).toBe(-1)
  })

  it('returns 0 for equal versions', () => {
    expect(sign('2.1.0', '2.1.0')).toBe(0)
  })

  it('puts a shorter prefix first', () => {
    expect(sign('2.1', '2.1.0')).toBe(-1)
  })

  it('sorts a list oldest first', () => {
    expect(['2.1.99', '2.10.0', '2.1.330', '2.0.5'].sort(compareVersions)).toEqual(['2.0.5', '2.1.99', '2.1.330', '2.10.0'])
  })
})

describe('highestVersion', () => {
  it('picks the numerically highest key', () => {
    expect(highestVersion({ '2.1.99': 4, '2.1.330': 1, '2.0.5': 9 })).toBe('2.1.330')
  })

  it('returns null for no counts', () => {
    expect(highestVersion(undefined)).toBeNull()
    expect(highestVersion({})).toBeNull()
  })
})
