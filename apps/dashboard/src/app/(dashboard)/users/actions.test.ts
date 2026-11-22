import { describe, it, expect, vi, beforeEach } from 'vitest'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath }))
const setHideOnLeaderboard = vi.fn()
vi.mock('@/lib/api', () => ({ setHideOnLeaderboard }))

const { hideNameAction } = await import('./actions')

const form = (fields: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

beforeEach(() => vi.clearAllMocks())

describe('hideNameAction', () => {
  it('hides the name when the box is checked and refreshes the leaderboard', async () => {
    expect((await hideNameAction(null, form({ hide: 'on' }))).ok).toBe(true)
    expect(setHideOnLeaderboard).toHaveBeenCalledWith(true)
    expect(revalidatePath).toHaveBeenCalledWith('/users')
  })

  it('shows the name again when the box is unchecked', async () => {
    await hideNameAction(null, form({}))
    expect(setHideOnLeaderboard).toHaveBeenCalledWith(false)
  })

  it('passes the API error back', async () => {
    setHideOnLeaderboard.mockRejectedValue(new Error('Unauthorized'))
    expect(await hideNameAction(null, form({ hide: 'on' }))).toEqual({ ok: false, message: 'Unauthorized' })
  })
})
