import { describe, it, expect, vi, beforeEach } from 'vitest'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath }))
const getUserRole = vi.fn<() => Promise<string | null>>()
vi.mock('@/lib/session', () => ({ getUserRole }))
const setTicketPrefixes = vi.fn()
vi.mock('@/lib/api', () => ({ setTicketPrefixes }))

const { ticketPrefixesAction } = await import('./actions')
const form = (prefixes: string) => {
  const f = new FormData()
  f.set('prefixes', prefixes)
  return f
}

beforeEach(() => {
  vi.clearAllMocks()
  getUserRole.mockResolvedValue('admin')
})

describe('ticketPrefixesAction', () => {
  it('refuses a manager without calling the API', async () => {
    getUserRole.mockResolvedValue('manager')
    expect((await ticketPrefixesAction(null, form('PROJ'))).ok).toBe(false)
    expect(setTicketPrefixes).not.toHaveBeenCalled()
  })

  it('upper-cases, splits on commas or spaces and drops repeats', async () => {
    expect(await ticketPrefixesAction(null, form(' proj, WEB  proj '))).toEqual({ ok: true, message: 'Project keys saved.' })
    expect(setTicketPrefixes).toHaveBeenCalledWith(['PROJ', 'WEB'])
    expect(revalidatePath).toHaveBeenCalledWith('/tickets')
  })

  it('clears with an empty field', async () => {
    expect((await ticketPrefixesAction(null, form(''))).message).toBe('Project keys cleared.')
    expect(setTicketPrefixes).toHaveBeenCalledWith([])
  })

  it('rejects a bad key before calling the API', async () => {
    const r = await ticketPrefixesAction(null, form('PROJ, 9AB, X'))
    expect(r).toMatchObject({ ok: false })
    expect(r.message).toContain('9AB, X')
    expect(setTicketPrefixes).not.toHaveBeenCalled()
  })
})
