'use client'

import { useActionState } from 'react'
import { deleteUserAction, type TeamActionState } from './actions'
import { secondaryButtonClass } from '@/components/ui'

/** Deletes a person and everything BurnWatch holds on them, after a browser confirm. */
export function DeleteUserButton({ userId, name, email }: { userId: string; name: string; email: string }) {
  const [state, dispatch, pending] = useActionState<TeamActionState | null, FormData>(deleteUserAction, null)
  return (
    <form
      action={dispatch}
      onSubmit={(e) => {
        const ok = window.confirm(
          `Delete ${name} (${email})? This removes their usage history, seats, team places, devices and login. It cannot be undone.`,
        )
        if (!ok) e.preventDefault()
      }}
    >
      <input type="hidden" name="userId" value={userId} />
      <button type="submit" disabled={pending} aria-label={`Delete ${name}`} className={secondaryButtonClass}>
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      {state && !state.ok && (
        <p role="status" className="mt-1 text-xs text-bad">
          {state.message}
        </p>
      )}
    </form>
  )
}
