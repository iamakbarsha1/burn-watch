import { describe, it, expect, vi, beforeEach } from 'vitest'

// `revalidatePath` needs a request store that only exists inside a render.
const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath }))

const getUserRole = vi.fn<() => Promise<string | null>>()
vi.mock('@/lib/session', () => ({ getUserRole }))

const connectCopilot = vi.fn()
const disconnectCopilot = vi.fn()
const syncCopilot = vi.fn()
const createTeam = vi.fn()
const renameTeam = vi.fn()
const deleteTeam = vi.fn()
const setTeamMember = vi.fn()
const removeTeamMember = vi.fn()
const deleteUser = vi.fn()
const createBudgetAlert = vi.fn()
const updateBudgetAlert = vi.fn()
const setSeat = vi.fn()
const removeSeat = vi.fn()
const assignSeatToAll = vi.fn()
const createInvites = vi.fn()
vi.mock('@/lib/api', () => ({
  connectCopilot,
  disconnectCopilot,
  syncCopilot,
  // Imported by the module under test, never reached by these tests.
  createInvite: vi.fn(),
  createInvites,
  createBudgetAlert,
  updateBudgetAlert,
  deleteBudgetAlert: vi.fn(),
  createTeam,
  renameTeam,
  deleteTeam,
  setTeamMember,
  removeTeamMember,
  deleteUser,
  setSeat,
  removeSeat,
  assignSeatToAll,
}))

const {
  connectCopilotAction,
  disconnectCopilotAction,
  syncCopilotAction,
  createTeamAction,
  renameTeamAction,
  deleteTeamAction,
  setTeamMemberAction,
  removeTeamMemberAction,
  deleteUserAction,
  createBudgetAlertAction,
  updateBudgetAlertAction,
  setSeatAction,
  removeSeatAction,
  assignSeatToAllAction,
  bulkInviteAction,
} = await import('./actions.js')

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
    ['bulkInviteAction', bulkInviteAction, createInvites, { csv: 'a@b.c' }],
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

describe('team actions', () => {
  const TEAM = '11111111-1111-4111-8111-111111111111'
  const USER = '22222222-2222-4222-8222-222222222222'

  const cases = [
    ['createTeamAction', createTeamAction, createTeam, { name: 'Platform' }],
    ['renameTeamAction', renameTeamAction, renameTeam, { teamId: TEAM, name: 'Infra' }],
    ['deleteTeamAction', deleteTeamAction, deleteTeam, { teamId: TEAM }],
    ['setTeamMemberAction', setTeamMemberAction, setTeamMember, { teamId: TEAM, userId: USER, role: 'manager' }],
    ['removeTeamMemberAction', removeTeamMemberAction, removeTeamMember, { teamId: TEAM, userId: USER }],
    ['deleteUserAction', deleteUserAction, deleteUser, { userId: USER }],
  ] as const

  for (const [name, action, apiFn, fields] of cases) {
    it(`${name} refuses a manager and calls nothing`, async () => {
      getUserRole.mockResolvedValue('manager')
      const state = await action(null, form(fields))
      expect(state).toMatchObject({ ok: false, message: 'Admin role required' })
      expect(apiFn).not.toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
    })

    it(`${name} calls the API and revalidates every page`, async () => {
      const state = await action(null, form(fields))
      expect(state.ok).toBe(true)
      expect(apiFn).toHaveBeenCalledTimes(1)
      expect(revalidatePath).toHaveBeenCalledWith('/', 'layout')
    })
  }

  it('passes the user id through to deleteUser, and shows the API refusal for yourself', async () => {
    await deleteUserAction(null, form({ userId: USER }))
    expect(deleteUser).toHaveBeenCalledWith(USER)
    deleteUser.mockRejectedValueOnce(new Error('You cannot delete yourself'))
    const state = await deleteUserAction(null, form({ userId: USER }))
    expect(state).toMatchObject({ ok: false, message: 'You cannot delete yourself' })
  })

  it('passes ids and role through to setTeamMember', async () => {
    await setTeamMemberAction(null, form({ teamId: TEAM, userId: USER, role: 'member' }))
    expect(setTeamMember).toHaveBeenCalledWith(TEAM, USER, 'member')
  })

  it('refuses an unknown team role without calling the API', async () => {
    const state = await setTeamMemberAction(null, form({ teamId: TEAM, userId: USER, role: 'owner' }))
    expect(state.ok).toBe(false)
    expect(setTeamMember).not.toHaveBeenCalled()
  })

  it('refuses a blank name without calling the API', async () => {
    const state = await createTeamAction(null, form({ name: '   ' }))
    expect(state).toMatchObject({ ok: false, message: 'Enter a team name' })
    expect(createTeam).not.toHaveBeenCalled()
  })

  it("returns the API's own words on failure", async () => {
    createTeam.mockRejectedValueOnce(new Error('A team with this name already exists'))
    const state = await createTeamAction(null, form({ name: 'Platform' }))
    expect(state).toMatchObject({ ok: false, message: 'A team with this name already exists' })
  })
})

describe('budget alert types', () => {
  it('sends limit and threshold for api-spend, and defaults to it when no type is given', async () => {
    const state = await createBudgetAlertAction(null, form({ monthlyLimitUsd: '100', thresholdPct: '80' }))
    expect(state.ok).toBe(true)
    expect(createBudgetAlert).toHaveBeenCalledWith({
      type: 'api-spend',
      monthlyLimitUsd: 100,
      threshold: 0.8,
      agent: null,
    })
  })

  it('sends only idle days for idle-seat, ignoring a stray limit', async () => {
    await createBudgetAlertAction(
      null,
      form({ type: 'idle-seat', idleDays: '14', monthlyLimitUsd: '100', agent: 'claude' }),
    )
    expect(createBudgetAlert).toHaveBeenCalledWith({ type: 'idle-seat', idleDays: 14, agent: 'claude' })
  })

  it('sends only limit hits for limit-hit', async () => {
    await createBudgetAlertAction(null, form({ type: 'limit-hit', limitHits: '3' }))
    expect(createBudgetAlert).toHaveBeenCalledWith({ type: 'limit-hit', limitHits: 3, agent: null })
  })

  it('refuses idle days that are not a whole number in range', async () => {
    for (const idleDays of ['0', '2.5', '366', '']) {
      const state = await createBudgetAlertAction(null, form({ type: 'idle-seat', idleDays }))
      expect(state).toMatchObject({ ok: false, message: 'Enter unused days between 1 and 365' })
    }
    expect(createBudgetAlert).not.toHaveBeenCalled()
  })

  it('refuses an unknown type without calling the API', async () => {
    const state = await createBudgetAlertAction(null, form({ type: 'weekly', monthlyLimitUsd: '100', thresholdPct: '80' }))
    expect(state).toMatchObject({ ok: false, message: 'Unknown alert type' })
    expect(createBudgetAlert).not.toHaveBeenCalled()
  })

  it('carries the type on an update, so the API checks the right field', async () => {
    await updateBudgetAlertAction(null, form({ id: 'a1', type: 'idle-seat', idleDays: '30', agent: '' }))
    expect(updateBudgetAlert).toHaveBeenCalledWith('a1', { type: 'idle-seat', idleDays: 30, agent: null })
  })

  it('never sends a person: alerts are org-wide or per agent', async () => {
    await createBudgetAlertAction(null, form({ type: 'limit-hit', limitHits: '3', userId: '22222222-2222-4222-8222-222222222222' }))
    expect(createBudgetAlert.mock.calls[0][0]).not.toHaveProperty('userId')
  })
})

describe('seat actions', () => {
  const USER = '22222222-2222-4222-8222-222222222222'
  const SEAT = { userId: USER, agent: 'claude', monthlyPriceUsd: '200', startDate: '2026-11-01' }

  beforeEach(() => {
    setSeat.mockResolvedValue({ userId: USER, agent: 'claude' })
    removeSeat.mockResolvedValue({ userId: USER, agent: 'claude' })
    assignSeatToAll.mockResolvedValue({ created: 3 })
  })

  const cases = [
    ['setSeatAction', setSeatAction, setSeat, SEAT],
    ['removeSeatAction', removeSeatAction, removeSeat, { userId: USER, agent: 'claude' }],
    ['assignSeatToAllAction', assignSeatToAllAction, assignSeatToAll, { agent: 'claude', monthlyPriceUsd: '30', startDate: '2026-11-01' }],
  ] as const

  for (const [name, action, apiFn, fields] of cases) {
    it(`${name} refuses a manager and calls nothing`, async () => {
      getUserRole.mockResolvedValue('manager')
      const state = await action(null, form(fields))
      expect(state).toMatchObject({ ok: false, message: 'Admin role required' })
      expect(apiFn).not.toHaveBeenCalled()
      expect(revalidatePath).not.toHaveBeenCalled()
    })

    it(`${name} calls the API and revalidates every page`, async () => {
      const state = await action(null, form(fields))
      expect(state.ok).toBe(true)
      expect(apiFn).toHaveBeenCalledTimes(1)
      expect(revalidatePath).toHaveBeenCalledWith('/', 'layout')
    })
  }

  it('passes the seat through as numbers', async () => {
    await setSeatAction(null, form(SEAT))
    expect(setSeat).toHaveBeenCalledWith(USER, 'claude', { monthlyPriceUsd: 200, startDate: '2026-11-01' })
  })

  it('accepts a free seat', async () => {
    const state = await setSeatAction(null, form({ ...SEAT, monthlyPriceUsd: '0' }))
    expect(state.ok).toBe(true)
  })

  it('refuses a blank or negative price without calling the API', async () => {
    for (const monthlyPriceUsd of ['', '-5', 'abc']) {
      const state = await setSeatAction(null, form({ ...SEAT, monthlyPriceUsd }))
      expect(state.ok).toBe(false)
    }
    expect(setSeat).not.toHaveBeenCalled()
  })

  it('refuses a bad date or agent without calling the API', async () => {
    expect((await setSeatAction(null, form({ ...SEAT, startDate: '11/01/2026' }))).ok).toBe(false)
    expect((await setSeatAction(null, form({ ...SEAT, agent: 'cursor' }))).ok).toBe(false)
    expect((await removeSeatAction(null, form({ userId: USER, agent: 'cursor' }))).ok).toBe(false)
    expect(setSeat).not.toHaveBeenCalled()
    expect(removeSeat).not.toHaveBeenCalled()
  })

  it('says how many seats assign-all created', async () => {
    const state = await assignSeatToAllAction(null, form({ agent: 'copilot', monthlyPriceUsd: '19', startDate: '2026-11-01' }))
    expect(assignSeatToAll).toHaveBeenCalledWith({ agent: 'copilot', monthlyPriceUsd: 19, startDate: '2026-11-01' })
    expect(state.message).toBe('Added 3 copilot seats. Existing seats were left as they were.')
  })

  it('says nothing changed when everyone already has a seat', async () => {
    assignSeatToAll.mockResolvedValueOnce({ created: 0 })
    const state = await assignSeatToAllAction(null, form({ agent: 'claude', monthlyPriceUsd: '30', startDate: '2026-11-01' }))
    expect(state).toEqual({ ok: true, message: 'Everyone already has a claude seat. Nothing changed.' })
  })

  it("returns the API's own words on failure", async () => {
    setSeat.mockRejectedValueOnce(new Error('User not found in this organization'))
    const state = await setSeatAction(null, form(SEAT))
    expect(state).toEqual({ ok: false, message: 'User not found in this organization' })
  })
})

describe('bulkInviteAction', () => {
  it('sends parsed rows and returns invite paths, never full URLs', async () => {
    createInvites.mockResolvedValue({
      results: [
        { ok: true, email: 'a@b.c', role: 'manager', token: 'tok', expiresAt: '2026-11-29T00:00:00Z' },
        { ok: false, email: 'bad', error: 'Not a valid email' },
      ],
    })

    const state = await bulkInviteAction(null, form({ csv: 'email,role,team\na@b.c,manager,Platform\nbad,,' }))

    expect(createInvites).toHaveBeenCalledWith([
      { email: 'a@b.c', role: 'manager', team: 'Platform' },
      { email: 'bad', role: undefined, team: undefined },
    ])
    expect(state).toEqual({
      ok: true,
      message: '1 of 2 invites created.',
      results: [
        { email: 'a@b.c', ok: true, path: '/invite/tok' },
        { email: 'bad', ok: false, error: 'Not a valid email' },
      ],
    })
    expect(revalidatePath).toHaveBeenCalledWith('/admin')
  })

  it('refuses an empty upload and one over 200 rows without calling the API', async () => {
    expect((await bulkInviteAction(null, form({ csv: '\n' }))).ok).toBe(false)
    const csv = Array.from({ length: 201 }, (_, i) => `u${i}@b.c`).join('\n')
    expect((await bulkInviteAction(null, form({ csv }))).message).toContain('limit is 200')
    expect(createInvites).not.toHaveBeenCalled()
  })
})
