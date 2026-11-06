'use client'

import { useActionState, useEffect, useState } from 'react'
import { inviteAction } from './actions'
import { inputClass, buttonClass, secondaryButtonClass } from '@/components/ui'

export function InviteForm() {
  const [state, dispatch, pending] = useActionState(inviteAction, null)
  const [origin, setOrigin] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => setOrigin(window.location.origin), [])
  useEffect(() => setCopied(false), [state])

  const link = state?.path ? `${origin}${state.path}` : ''

  return (
    <form action={dispatch}>
      <div className="flex flex-wrap items-start gap-2">
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
        <div className="w-40">
          <label className="sr-only" htmlFor="invite-role">
            Role
          </label>
          <select id="invite-role" name="role" defaultValue="developer" className={`${inputClass} w-full`}>
            <option value="developer">Developer</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Creating…' : 'Create invite'}
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

      {link && (
        <div className="mt-2">
          <p className="text-sm text-ink-2">
            Send this link to {state?.email}. It is shown once — the server keeps only a hash.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded border border-line bg-surface-2 px-2 py-1 text-xs text-ink">
              {link}
            </code>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={async () => {
                await navigator.clipboard.writeText(link)
                setCopied(true)
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </form>
  )
}
