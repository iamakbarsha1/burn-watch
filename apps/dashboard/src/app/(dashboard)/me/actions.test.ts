import { describe, it, expect, vi, beforeEach } from 'vitest'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath }))
const setHelpVolunteer = vi.fn()
vi.mock('@/lib/api', () => ({ setHelpVolunteer }))

const { helpVolunteerAction } = await import('./actions')

const form = (checked: boolean) => {
  const f = new FormData()
  if (checked) f.set('helpVolunteer', 'on')
  return f
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('helpVolunteerAction', () => {
  it('turns it on from a checked box and refreshes My usage and Adoption', async () => {
    expect(await helpVolunteerAction(null, form(true))).toEqual({
      ok: true,
      message: 'Your name now shows on the Adoption page.',
    })
    expect(setHelpVolunteer).toHaveBeenCalledWith(true)
    expect(revalidatePath).toHaveBeenCalledWith('/me')
    expect(revalidatePath).toHaveBeenCalledWith('/adoption')
  })

  it('turns it off when the box is not sent', async () => {
    expect((await helpVolunteerAction(null, form(false))).ok).toBe(true)
    expect(setHelpVolunteer).toHaveBeenCalledWith(false)
  })

  it('returns the API error without refreshing', async () => {
    setHelpVolunteer.mockRejectedValueOnce(new Error('API 500'))
    expect(await helpVolunteerAction(null, form(true))).toEqual({ ok: false, message: 'API 500' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
