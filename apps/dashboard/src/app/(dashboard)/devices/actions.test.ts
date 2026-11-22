import { describe, it, expect, vi, beforeEach } from 'vitest'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath }))

const getUserRole = vi.fn<() => Promise<string | null>>()
vi.mock('@/lib/session', () => ({ getUserRole, getApiToken: vi.fn(), getSession: vi.fn() }))

const updateDeviceSettings = vi.fn()
vi.mock('@/lib/api', () => ({ updateDeviceSettings, approveDevice: vi.fn(), revokeDevice: vi.fn() }))

const { deviceSettingsAction } = await import('./actions')

const form = (fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  getUserRole.mockResolvedValue('admin')
  updateDeviceSettings.mockImplementation(async (input) => input)
})

describe('deviceSettingsAction', () => {
  it('refuses a non-admin without calling the API', async () => {
    getUserRole.mockResolvedValue('manager')
    expect(await deviceSettingsAction(null, form({ minClaudeVersion: '2.1.0' }))).toEqual({ ok: false, message: 'Admin role required' })
    expect(updateDeviceSettings).not.toHaveBeenCalled()
  })

  it('saves a trimmed version and revalidates /devices', async () => {
    const res = await deviceSettingsAction(null, form({ minClaudeVersion: ' 2.1.0 ' }))
    expect(res).toEqual({ ok: true, message: 'Minimum set to 2.1.0.' })
    expect(updateDeviceSettings).toHaveBeenCalledWith({ minClaudeVersion: '2.1.0' })
    expect(revalidatePath).toHaveBeenCalledWith('/devices')
  })

  it('clears with the Clear button, whatever the input holds', async () => {
    const res = await deviceSettingsAction(null, form({ minClaudeVersion: '2.1.0', intent: 'clear' }))
    expect(res).toEqual({ ok: true, message: 'Minimum cleared.' })
    expect(updateDeviceSettings).toHaveBeenCalledWith({ minClaudeVersion: null })
  })

  it.each(['', '2.1', 'latest', '2.1.0-beta'])('rejects %j without calling the API', async (v) => {
    expect((await deviceSettingsAction(null, form({ minClaudeVersion: v }))).ok).toBe(false)
    expect(updateDeviceSettings).not.toHaveBeenCalled()
  })
})
