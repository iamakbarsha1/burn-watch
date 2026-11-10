import { describe, it, expect, vi, beforeEach } from 'vitest'

// `revalidatePath` needs a request store that only exists inside a render.
const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath }))

const getUserRole = vi.fn<() => Promise<string | null>>()
vi.mock('@/lib/session', () => ({ getUserRole }))

const connectCopilot = vi.fn()
const disconnectCopilot = vi.fn()
const syncCopilot = vi.fn()
vi.mock('@/lib/api', () => ({
  connectCopilot,
  disconnectCopilot,
  syncCopilot,
  // Imported by the module under test, never reached by these tests.
  createInvite: vi.fn(),
  createBudgetAlert: vi.fn(),
  updateBudgetAlert: vi.fn(),
  deleteBudgetAlert: vi.fn(),
}))

const { connectCopilotAction, disconnectCopilotAction, syncCopilotAction } = await import(
  './actions.js'
)

function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData()
  for (const [k, v] of Object.entries(fields)) data.append(k, v)
  return data
}

const SYNC_RESULT = {
  day: '2026-11-09',
  seats: { total: 12, skippedNullAssignee: 1 },
  usage: { matched: 9, written: 9, skipped: 0 },
  unmatchedLogins: ['Octocat'],
}

beforeEach(() => {
  vi.clearAllMocks()
  getUserRole.mockResolvedValue('admin')
  connectCopilot.mockResolvedValue({ connected: true, org: 'acme-inc' })
  disconnectCopilot.mockResolvedValue(undefined)
  syncCopilot.mockResolvedValue(SYNC_RESULT)
})

/**
 * The gate is the security boundary. A message saying "Admin role required" is
 * worth nothing if the call went out anyway, so every case here asserts the
 * API function was never reached, not just what came back.
 */
describe('admin role gate', () => {
  const cases = [
    ['connectCopilotAction', connectCopilotAction, connectCopilot, { org: 'a', token: 't' }],
    ['disconnectCopilotAction', disconnectCopilotAction, disconnectCopilot, {}],
    ['syncCopilotAction', syncCopilotAction, syncCopilot, {}],
  ] as const

  for (const [name, action, apiFn, fields] of cases) {
    it(`${name} refuses a developer and calls nothing`, async () => {
      getUserRole.mockResolvedValue('developer')

      const state = await action(null, form(fields))

      expect(state).toMatchObject({ ok: false, message: 'Admin role required' })
      expect(apiFn).not.toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
    })

    it(`${name} refuses a manager and calls nothing`, async () => {
      getUserRole.mockResolvedValue('manager')

      const state = await action(null, form(fields))

      expect(state.ok).toBe(false)
      expect(apiFn).not.toHaveBeenCalled()
    })

    it(`${name} refuses a signed-out caller and calls nothing`, async () => {
      // `getUserRole` answers null when the cookie is absent or unparseable.
      getUserRole.mockResolvedValue(null)

      const state = await action(null, form(fields))

      expect(state.ok).toBe(false)
      expect(apiFn).not.toHaveBeenCalled()
    })
  }
})

describe('connectCopilotAction', () => {
  it('passes the org and token through and revalidates the page', async () => {
    const state = await connectCopilotAction(null, form({ org: 'acme-inc', token: 'ghp_secret' }))

    expect(connectCopilot).toHaveBeenCalledWith('acme-inc', 'ghp_secret')
    expect(revalidatePath).toHaveBeenCalledWith('/admin')
    expect(state.ok).toBe(true)
  })

  /**
   * The token is a credential. It goes up to the API and nowhere else: not
   * into the message the panel renders, and not into the message a failure
   * renders either.
   */
  it('never puts the token in the returned message', async () => {
    const ok = await connectCopilotAction(null, form({ org: 'acme-inc', token: 'ghp_secret' }))
    expect(ok.message).not.toContain('ghp_secret')

    connectCopilot.mockRejectedValue(new Error('GitHub rejected this token for that organization'))
    const failed = await connectCopilotAction(null, form({ org: 'acme-inc', token: 'ghp_secret' }))
    expect(failed.message).not.toContain('ghp_secret')
    expect(failed.message).toBe('GitHub rejected this token for that organization')
  })

  it('trims the org and the token before sending them', async () => {
    await connectCopilotAction(null, form({ org: '  acme-inc  ', token: '  ghp_secret\n' }))
    expect(connectCopilot).toHaveBeenCalledWith('acme-inc', 'ghp_secret')
  })

  it('refuses an empty org without calling the API', async () => {
    const state = await connectCopilotAction(null, form({ org: '   ', token: 'ghp_secret' }))

    expect(state).toEqual({ ok: false, message: 'Enter the GitHub organization slug' })
    expect(connectCopilot).not.toHaveBeenCalled()
  })

  it('refuses an empty token without calling the API', async () => {
    const state = await connectCopilotAction(null, form({ org: 'acme-inc', token: '' }))

    expect(state).toEqual({ ok: false, message: 'Enter a GitHub token' })
    expect(connectCopilot).not.toHaveBeenCalled()
  })

  it('surfaces the API message rather than a generic failure', async () => {
    connectCopilot.mockRejectedValue(new Error('Credential encryption is not configured'))

    const state = await connectCopilotAction(null, form({ org: 'acme-inc', token: 'ghp_secret' }))

    expect(state).toEqual({ ok: false, message: 'Credential encryption is not configured' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe('disconnectCopilotAction', () => {
  it('disconnects and revalidates', async () => {
    const state = await disconnectCopilotAction(null, form())

    expect(disconnectCopilot).toHaveBeenCalledTimes(1)
    expect(revalidatePath).toHaveBeenCalledWith('/admin')
    expect(state.ok).toBe(true)
  })

  it('says the recorded usage survives', async () => {
    const state = await disconnectCopilotAction(null, form())
    expect(state.message).toContain('kept')
  })

  it('surfaces a failure instead of reporting success', async () => {
    disconnectCopilot.mockRejectedValue(new Error('API /v1/integrations/copilot/connection → 500'))

    const state = await disconnectCopilotAction(null, form())

    expect(state.ok).toBe(false)
    expect(state.message).toContain('500')
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe('syncCopilotAction', () => {
  it('syncs yesterday when no day is given', async () => {
    const state = await syncCopilotAction(null, form())

    expect(syncCopilot).toHaveBeenCalledWith(undefined)
    expect(state.ok).toBe(true)
  })

  it('syncs the day it was given', async () => {
    await syncCopilotAction(null, form({ day: '2026-11-09' }))
    expect(syncCopilot).toHaveBeenCalledWith('2026-11-09')
  })

  /**
   * The counts and the unmatched logins have to reach the panel. Dropping the
   * result would leave an admin with "Synced." and no way to see that four
   * developers' Copilot spend went unrecorded.
   */
  it('returns the whole result, unmatched logins included', async () => {
    const state = await syncCopilotAction(null, form({ day: '2026-11-09' }))

    expect(state.result).toEqual(SYNC_RESULT)
    expect(state.result?.unmatchedLogins).toEqual(['Octocat'])
  })

  it('rejects a malformed day before calling the API', async () => {
    const state = await syncCopilotAction(null, form({ day: '09-11-2026' }))

    expect(state.ok).toBe(false)
    expect(state.message).toContain('YYYY-MM-DD')
    expect(syncCopilot).not.toHaveBeenCalled()
  })

  it('carries no result on a failure', async () => {
    syncCopilot.mockRejectedValue(new Error('Copilot is not connected for this organization'))

    const state = await syncCopilotAction(null, form({ day: '2026-11-09' }))

    expect(state.ok).toBe(false)
    expect(state.message).toBe('Copilot is not connected for this organization')
    expect(state.result).toBeUndefined()
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
