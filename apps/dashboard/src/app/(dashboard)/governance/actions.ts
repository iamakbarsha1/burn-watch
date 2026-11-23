'use server'

import { revalidatePath } from 'next/cache'
import { approveMcpServer, clearAgentPolicy, revokeMcpServer, setAgentPolicy, setCompanyClaudeOrgs } from '@/lib/api'
import { getUserRole } from '@/lib/session'
import type { AgentName } from '@burn-watch/shared'

export interface McpActionState {
  ok: boolean
  message: string
}

/** Approve one MCP server key, or revoke it when `intent` is "revoke". Admin only; the API checks again. */
export async function mcpApprovalAction(_prev: McpActionState | null, formData: FormData): Promise<McpActionState> {
  if ((await getUserRole()) !== 'admin') return { ok: false, message: 'Admin role required' }
  const server = String(formData.get('server') ?? '')
  if (!server) return { ok: false, message: 'No server selected' }
  const revoke = formData.get('intent') === 'revoke'
  const note = String(formData.get('note') ?? '').trim() || null
  try {
    await (revoke ? revokeMcpServer(server) : approveMcpServer(server, note))
    revalidatePath('/governance')
    return { ok: true, message: revoke ? `${server} revoked.` : `${server} approved.` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to save approval' }
  }
}

const AGENTS: AgentName[] = ['claude', 'qwen', 'gemini', 'codex', 'copilot']
const RULES = ['allowed', 'models', 'blocked'] as const

/**
 * Save one agent's rule, or clear it back to "not set" when `intent` is
 * "clear". Models come one per line. Admin only; the API checks again.
 */
export async function agentPolicyAction(_prev: McpActionState | null, formData: FormData): Promise<McpActionState> {
  if ((await getUserRole()) !== 'admin') return { ok: false, message: 'Admin role required' }
  const agent = String(formData.get('agent') ?? '') as AgentName
  if (!AGENTS.includes(agent)) return { ok: false, message: 'Unknown agent' }
  const clear = formData.get('intent') === 'clear'
  const rule = String(formData.get('rule') ?? '') as (typeof RULES)[number]
  if (!clear && !RULES.includes(rule)) return { ok: false, message: 'Pick a rule' }
  const models = String(formData.get('models') ?? '')
    .split('\n')
    .map((m) => m.trim())
    .filter(Boolean)
  if (!clear && rule === 'models' && models.length === 0) {
    return { ok: false, message: 'List at least one model, or choose blocked' }
  }
  const note = String(formData.get('note') ?? '').trim() || null
  try {
    await (clear ? clearAgentPolicy(agent) : setAgentPolicy(agent, { rule, models, note }))
    // The nav count and the Overview line read the same policy.
    revalidatePath('/', 'layout')
    return { ok: true, message: clear ? `${agent} rule cleared.` : `${agent} rule saved.` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to save the rule' }
  }
}

/** R2 B6. Save which Claude orgs are the company's; none ticked clears it. Admin only; the API checks again. */
export async function claudeOrgsAction(_prev: McpActionState | null, formData: FormData): Promise<McpActionState> {
  if ((await getUserRole()) !== 'admin') return { ok: false, message: 'Admin role required' }
  const ids = formData.getAll('ids').map(String)
  try {
    await setCompanyClaudeOrgs(ids)
    revalidatePath('/governance')
    return { ok: true, message: ids.length ? 'Company Claude org saved.' : 'Company Claude org cleared.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to save' }
  }
}
