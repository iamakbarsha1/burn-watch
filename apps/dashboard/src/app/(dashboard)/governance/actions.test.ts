import { describe, it, expect, vi, beforeEach } from 'vitest'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath }))
const getUserRole = vi.fn<() => Promise<string | null>>()
vi.mock('@/lib/session', () => ({ getUserRole }))
const approveMcpServer = vi.fn()
const revokeMcpServer = vi.fn()
const setAgentPolicy = vi.fn()
const clearAgentPolicy = vi.fn()
vi.mock('@/lib/api', () => ({ approveMcpServer, revokeMcpServer, setAgentPolicy, clearAgentPolicy }))

const { mcpApprovalAction, agentPolicyAction } = await import('./actions')

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

describe('agentPolicyAction', () => {
  it('refuses a manager without calling the API', async () => {
    getUserRole.mockResolvedValue('manager')
    expect((await agentPolicyAction(null, form({ agent: 'claude', rule: 'allowed' }))).ok).toBe(false)
    expect(setAgentPolicy).not.toHaveBeenCalled()
  })

  it('sends models one per line, trimmed, and revalidates every page', async () => {
    const state = await agentPolicyAction(
      null,
      form({ agent: 'claude', rule: 'models', models: ' claude-opus-5 \n\nclaude-sonnet-5\n', note: '' }),
    )
    expect(state.ok).toBe(true)
    expect(setAgentPolicy).toHaveBeenCalledWith('claude', {
      rule: 'models',
      models: ['claude-opus-5', 'claude-sonnet-5'],
      note: null,
    })
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout')
  })

  it('asks for a model when models-only has none', async () => {
    expect((await agentPolicyAction(null, form({ agent: 'claude', rule: 'models', models: ' ' }))).message).toBe(
      'List at least one model, or choose blocked',
    )
    expect(setAgentPolicy).not.toHaveBeenCalled()
  })

  it('rejects an unknown agent', async () => {
    expect((await agentPolicyAction(null, form({ agent: 'cursor', rule: 'allowed' }))).message).toBe('Unknown agent')
  })

  it('clears a rule', async () => {
    await agentPolicyAction(null, form({ agent: 'qwen', intent: 'clear' }))
    expect(clearAgentPolicy).toHaveBeenCalledWith('qwen')
    expect(setAgentPolicy).not.toHaveBeenCalled()
  })
})
