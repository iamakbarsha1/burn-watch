import { describe, it, expect } from 'vitest'
import { usageBand } from './distribution.js'

describe('usageBand', () => {
  it.each([
    [0, 14, 'none'],
    [14, 14, '5+'],
    [1, 30, '1-2'], // rounds to 0 a week, but any use is at least 1-2
    [8, 14, '3-4'],
    [1, 1, '1-2'], // a range under a week counts as one week
  ] as const)('%i active days over %i -> %s', (days, range, band) => {
    expect(usageBand(days, range)).toBe(band)
  })
})
