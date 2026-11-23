'use client'

import { useActionState } from 'react'
import { buttonClass, inputClass } from '@/components/ui'
import { ticketPrefixesAction, type TicketActionState } from './actions'

/** R2 C4. The org's Jira project keys. Rendered for admins only. */
export function TicketSettingsForm({ prefixes, suggestions }: { prefixes: string[]; suggestions: string[] }) {
  const [state, dispatch, pending] = useActionState<TicketActionState | null, FormData>(ticketPrefixesAction, null)
  return (
    <form action={dispatch} className="space-y-2 text-sm">
      <label className="block">
        <span className="text-xs text-ink-2">Jira project keys, comma separated</span>
        <input
          name="prefixes"
          defaultValue={prefixes.join(', ')}
          placeholder="PROJ, WEB"
          className={`${inputClass} w-full sm:w-96`}
        />
      </label>
      {suggestions.length > 0 && (
        <p className="text-xs text-ink-2">Seen in branch names, not counted yet: {suggestions.join(', ')}</p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      {state && (
        <p role="status" className={`text-xs ${state.ok ? 'text-good' : 'text-bad'}`}>
          {state.message}
        </p>
      )}
    </form>
  )
}
