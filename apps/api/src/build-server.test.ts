import { describe, it, expect } from 'vitest'

describe('api test wiring', () => {
  // Imports through a `.js` specifier that resolves to a `.ts` file, and pulls
  // in the db plugin transitively. If either resolution or the module-scope
  // client singleton needed env vars at import time, this fails — which is
  // exactly what the route tests in BW-10 depend on not happening.
  // The import compiles the whole server module graph on a cold cache, which
  // has run past the 5s default while the other workspaces build alongside it.
  it('imports buildServer without env vars or a live connection', async () => {
    const { buildServer } = await import('./build-server.js')
    expect(typeof buildServer).toBe('function')
  }, 30_000)
})
