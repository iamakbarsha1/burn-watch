'use client'

import { useActionState } from 'react'
import { secondaryButtonClass } from '@/components/ui'
import { hideNameAction } from './actions'

/** "Hide my name on the leaderboard": others see "Anonymous", admins still see the name. */
export function HideNameForm({ hidden }: { hidden: boolean }) {
  const [state, dispatch, pending] = useActionState(hideNameAction, null)
  return (
    <form action={dispatch} className="mt-4 flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" name="hide" defaultChecked={hidden} />
        <span>Hide my name on the leaderboard</span>
      </label>
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <span className="text-xs text-ink-3">Others see &quot;Anonymous&quot;. Admins still see your name.</span>
      {state && (
        <span role="status" className={`text-xs ${state.ok ? 'text-good' : 'text-bad'}`}>
          {state.message}
        </span>
      )}
    </form>
  )
}
