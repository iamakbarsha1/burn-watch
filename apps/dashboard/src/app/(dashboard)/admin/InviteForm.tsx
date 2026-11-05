'use client'

import { useActionState } from 'react'
import { inviteAction } from './actions'
import { inputClass, buttonClass } from '@/components/ui'

export function InviteForm() {
  const [state, dispatch, pending] = useActionState(inviteAction, null)

  return (
    <form action={dispatch}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-48">
          <label className="sr-only" htmlFor="invite-name">
            Full name
          </label>
          <input
            id="invite-name"
            name="name"
            type="text"
            placeholder="Full name"
            required
            className={`${inputClass} w-full`}
          />
        </div>
        <div className="min-w-56 flex-1">
          <label className="sr-only" htmlFor="invite-email">
            Work email
          </label>
          <input
            id="invite-email"
            name="email"
            type="email"
            placeholder="developer@company.com"
            required
            aria-describedby={state ? 'invite-status' : undefined}
            className={`${inputClass} w-full`}
          />
        </div>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Inviting…' : 'Invite'}
        </button>
      </div>

      {state && (
        <p
          id="invite-status"
          role="status"
          className={`mt-3 text-sm ${state.ok ? 'text-good' : 'text-bad'}`}
        >
          {state.message}
        </p>
      )}
    </form>
  )
}
