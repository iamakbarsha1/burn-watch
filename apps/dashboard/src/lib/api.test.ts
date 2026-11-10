import { describe, it, expect, vi, beforeEach } from 'vitest'

// `api.ts` reads the auth cookie through `next/headers`, which only resolves
// inside a request. The jar is the one thing these tests have to stand in for;
// everything else below is the real client.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'test-token' }) }),
}))

const {
  createBudgetAlert,
  deleteBudgetAlert,
  fetchCopilotStatus,
  connectCopilot,
  disconnectCopilot,
  syncCopilot,
} = await import('./api.js')

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

/**
 * A fetch stub that answers with whatever the route under test really returns,
 * rather than the single budget-alert shape the block above needs.
 */
function stubFetch(res: { status?: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const status = res.status ?? 200
  const text = res.body === undefined ? '' : JSON.stringify(res.body)
  vi.stubGlobal('fetch', (url: string, init: RequestInit | undefined) => {
    calls.push({ url, init })
    return Promise.resolve({
      ok: status < 400,
      status,
      // The real thing: an empty body throws here, which is the whole point of
      // the 204 case below.
      json: async () => JSON.parse(text),
      text: async () => text,
    })
  })
  return calls
}

function body(init: RequestInit | undefined): unknown {
  return JSON.parse(String(init?.body))
}

describe('copilot client', () => {
  it('reads the status off the integrations prefix', async () => {
    const calls = stubFetch({
      body: { encryption: 'ready', connected: true, org: 'acme-inc', lastSyncAt: null },
    })
    const status = await fetchCopilotStatus()

    expect(calls[0].url).toBe('http://localhost:3001/v1/integrations/copilot/status')
    expect(status.org).toBe('acme-inc')
    expect(status.encryption).toBe('ready')
  })

  it('puts the org and the token on the connection', async () => {
    const calls = stubFetch({ body: { connected: true, org: 'acme-inc' } })
    await connectCopilot('acme-inc', 'ghp_secret')

    expect(calls[0].init?.method).toBe('PUT')
    expect(calls[0].url).toBe('http://localhost:3001/v1/integrations/copilot/connection')
    expect(body(calls[0].init)).toEqual({ org: 'acme-inc', token: 'ghp_secret' })
  })

  it('surfaces the API error text rather than the status code', async () => {
    stubFetch({
      status: 400,
      body: { error: 'GitHub rejected this token for that organization', githubStatus: 401 },
    })

    await expect(connectCopilot('acme-inc', 'nope')).rejects.toThrow(
      'GitHub rejected this token for that organization',
    )
  })

  it('surfaces the 503 encryption error as the API worded it', async () => {
    stubFetch({
      status: 503,
      body: { error: 'Credential encryption is not configured', encryption: 'missing-key' },
    })

    await expect(connectCopilot('acme-inc', 'ghp_secret')).rejects.toThrow(
      'Credential encryption is not configured',
    )
  })

  /**
   * The regression this exists for: `apiMutate` ended in `res.json()`
   * unconditionally. DELETE /copilot/connection answers 204 with no body, and
   * parsing an empty one throws a SyntaxError that surfaces to the admin as
   * "Unexpected end of JSON input" on a disconnect that in fact worked.
   */
  it('accepts a bodyless 204 on disconnect', async () => {
    const calls = stubFetch({ status: 204 })

    await expect(disconnectCopilot()).resolves.toBeUndefined()
    expect(calls[0].init?.method).toBe('DELETE')
    expect(calls[0].init?.body).toBeUndefined()
    expect(Object.keys((calls[0].init?.headers ?? {}) as object)).not.toContain('Content-Type')
  })

  it('posts an empty body when no day is given', async () => {
    // Empty, not absent: the API picks yesterday UTC, and sending no body at
    // all is a different request.
    const calls = stubFetch({ body: syncBody() })
    await syncCopilot()

    expect(calls[0].init?.method).toBe('POST')
    expect(body(calls[0].init)).toEqual({})
  })

  it('posts the day when one is given', async () => {
    const calls = stubFetch({ body: syncBody() })
    await syncCopilot('2026-11-09')

    expect(body(calls[0].init)).toEqual({ day: '2026-11-09' })
  })

  it('returns the unmatched logins the sync reported', async () => {
    stubFetch({ body: syncBody({ unmatchedLogins: ['Octocat', 'hubot'] }) })
    const result = await syncCopilot('2026-11-09')

    expect(result.unmatchedLogins).toEqual(['Octocat', 'hubot'])
    expect(result.seats.skippedNullAssignee).toBe(1)
  })
})

function syncBody(over: Record<string, unknown> = {}) {
  return {
    day: '2026-11-09',
    seats: { total: 12, skippedNullAssignee: 1 },
    usage: { matched: 9, written: 9, skipped: 0 },
    unmatchedLogins: [],
    ...over,
  }
}
