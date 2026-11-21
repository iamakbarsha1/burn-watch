'use client'

import { useActionState } from 'react'
import { secondaryButtonClass } from '@/components/ui'
import { mcpApprovalAction, type McpActionState } from './actions'

/** Approve or revoke one server key. Rendered for admins only. */
export function McpApprovalButton({ server, approved }: { server: string; approved: boolean }) {
  const [state, dispatch, pending] = useActionState<McpActionState | null, FormData>(mcpApprovalAction, null)
  return (
    <form
      action={dispatch}
      onSubmit={(e) => {
        if (approved && !window.confirm(`Revoke the approval for ${server}?`)) e.preventDefault()
      }}
    >
      <input type="hidden" name="server" value={server} />
      <input type="hidden" name="intent" value={approved ? 'revoke' : 'approve'} />
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? 'Saving…' : approved ? 'Revoke' : 'Approve'}
      </button>
      {state && !state.ok && (
        <p role="status" className="mt-1 text-xs text-bad">
          {state.message}
        </p>
      )}
    </form>
  )
}
