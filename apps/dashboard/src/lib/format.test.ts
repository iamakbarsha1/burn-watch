import { describe, it, expect } from 'vitest'

describe('dashboard test wiring', () => {
  it('runs vitest in the dashboard workspace', () => {
    expect(new Intl.NumberFormat('en-US').format(1000)).toBe('1,000')
  })
})
