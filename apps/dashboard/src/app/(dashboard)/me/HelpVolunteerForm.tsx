'use client'

import { useActionState } from 'react'
import { secondaryButtonClass } from '@/components/ui'
import { helpVolunteerAction, type HelpVolunteerState } from './actions'

/** v2 Phase 2. The person's own opt-in; nobody else can set it. */
export function HelpVolunteerForm({ helpVolunteer }: { helpVolunteer: boolean }) {
  const [state, dispatch, pending] = useActionState<HelpVolunteerState | null, FormData>(helpVolunteerAction, null)
  return (
    <form action={dispatch} className="space-y-2 text-sm">
      <label className="flex items-center gap-2 text-ink">
        <input type="checkbox" name="helpVolunteer" defaultChecked={helpVolunteer} />
        Happy to help with Claude Code
      </label>
      <p className="text-xs text-ink-2">Your name shows on the Adoption page under your teams. Turn it off any time.</p>
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
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
