import { describe, it, expect } from 'vitest'

describe('api test wiring', () => {
  // Imports through a `.js` specifier that resolves to a `.ts` file, and pulls
  // in the db and redis plugins transitively. If either resolution or the
  // module-scope client singletons needed env vars at import time, this fails —
  // which is exactly what the route tests in BW-10 depend on not happening.
  it('imports buildServer without env vars or a live connection', async () => {
    const { buildServer } = await import('./build-server.js')
    expect(typeof buildServer).toBe('function')
  })
})
