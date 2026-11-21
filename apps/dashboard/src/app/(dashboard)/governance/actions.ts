'use server'

import { revalidatePath } from 'next/cache'
import { approveMcpServer, revokeMcpServer } from '@/lib/api'
import { getUserRole } from '@/lib/session'

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
