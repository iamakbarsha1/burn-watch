import { describe, it, expect, vi, beforeEach } from 'vitest'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath }))
const getUserRole = vi.fn<() => Promise<string | null>>()
vi.mock('@/lib/session', () => ({ getUserRole }))
const approveMcpServer = vi.fn()
const revokeMcpServer = vi.fn()
vi.mock('@/lib/api', () => ({ approveMcpServer, revokeMcpServer }))

const { mcpApprovalAction } = await import('./actions')

const form = (fields: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

beforeEach(() => {
  vi.clearAllMocks()
  getUserRole.mockResolvedValue('admin')
})

describe('mcpApprovalAction', () => {
  it('refuses a manager without calling the API', async () => {
    getUserRole.mockResolvedValue('manager')
    expect(await mcpApprovalAction(null, form({ server: 'Neon' }))).toEqual({ ok: false, message: 'Admin role required' })
    expect(approveMcpServer).not.toHaveBeenCalled()
  })

  it('approves the exact key with no note and revalidates the page', async () => {
    const state = await mcpApprovalAction(null, form({ server: 'claude_ai_Neon', intent: 'approve' }))
    expect(state.ok).toBe(true)
    expect(approveMcpServer).toHaveBeenCalledWith('claude_ai_Neon', null)
    expect(revalidatePath).toHaveBeenCalledWith('/governance')
  })

  it('revokes when asked', async () => {
    await mcpApprovalAction(null, form({ server: 'Neon', intent: 'revoke' }))
    expect(revokeMcpServer).toHaveBeenCalledWith('Neon')
    expect(approveMcpServer).not.toHaveBeenCalled()
  })

  it('passes the API error back', async () => {
    approveMcpServer.mockRejectedValue(new Error('Validation failed'))
    expect(await mcpApprovalAction(null, form({ server: 'Neon' }))).toEqual({ ok: false, message: 'Validation failed' })
  })
})
