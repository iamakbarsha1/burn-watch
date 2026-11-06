import { describe, it, expect, vi, beforeEach } from 'vitest'

// `api.ts` reads the auth cookie through `next/headers`, which only resolves
// inside a request. The jar is the one thing these tests have to stand in for;
// everything else below is the real client.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'test-token' }) }),
}))

const { createBudgetAlert, deleteBudgetAlert } = await import('./api.js')

function captureFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve({
      ok: status < 400,
      status,
      json: async () => ({ id: 'alert-1' }),
      text: async () => '{}',
    })
  })
  return calls
}

function headerNames(init: RequestInit): string[] {
  return Object.keys((init.headers ?? {}) as Record<string, string>)
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('apiMutate content type', () => {
  /**
   * The regression this exists for: `apiMutate` used to set
   * `Content-Type: application/json` on every call including the bodyless
   * ones. Fastify answers 400 to an empty body that claims to be JSON, so
   * every DELETE failed before reaching its route — and the admin panel
   * discarded the error, so the row just sat there looking undeleted.
   */
  it('sends no content type on a request with no body', async () => {
    const calls = captureFetch()
    await deleteBudgetAlert('alert-1')

    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].init.body).toBeUndefined()
    expect(headerNames(calls[0].init)).not.toContain('Content-Type')
  })

  it('still declares json when there is a body to declare it for', async () => {
    const calls = captureFetch()
    await createBudgetAlert({ userId: null, agent: null, monthlyLimitUsd: 100, threshold: 0.8 })

    const headers = (calls[0].init.headers ?? {}) as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(calls[0].init.body).toBe(
      JSON.stringify({ userId: null, agent: null, monthlyLimitUsd: 100, threshold: 0.8 }),
    )
  })

  it('carries the auth token on both', async () => {
    const calls = captureFetch()
    await deleteBudgetAlert('alert-1')

    const headers = (calls[0].init.headers ?? {}) as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-token')
  })
})
