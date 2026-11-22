'use client'

import { useActionState } from 'react'
import type { LeaderboardSettings } from '@burn-watch/shared'
import { buttonClass, inputClass } from '@/components/ui'
import { leaderboardSettingsAction } from './actions'

/** The three org leaderboard settings. Rendered for admins only. */
export function LeaderboardSettingsForm({ settings }: { settings: LeaderboardSettings }) {
  const [state, dispatch, pending] = useActionState(leaderboardSettingsAction, null)
  return (
    <form action={dispatch} className="space-y-3 text-sm">
      <label className="block">
        <span className="text-xs text-ink-2">Developers see</span>
        <select name="developerView" defaultValue={settings.developerView} className={`${inputClass} w-full sm:w-80`}>
          <option value="own">Their own row only</option>
          <option value="rank">Their own row and rank, no other people</option>
          <option value="full">The whole list</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="showNames" defaultChecked={settings.showNames} />
        <span>Show names to managers and developers (off shows Person 1, 2, ...)</span>
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="showOthersCost" defaultChecked={settings.showOthersCost} />
        <span>Let developers see cost on other people&apos;s rows</span>
      </label>
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
