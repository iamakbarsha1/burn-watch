'use client'

import { useActionState } from 'react'
import { buttonClass, inputClass, secondaryButtonClass } from '@/components/ui'
import { deviceSettingsAction } from './actions'

/** The org's minimum Claude Code version. Rendered for admins only. */
export function DeviceSettingsForm({ minClaudeVersion }: { minClaudeVersion: string | null }) {
  const [state, dispatch, pending] = useActionState(deviceSettingsAction, null)
  return (
    <form action={dispatch} className="space-y-2 text-sm">
      <label className="block text-xs text-ink-2" htmlFor="min-claude-version">
        Minimum Claude Code version, e.g. 2.1.0
      </label>
      <div className="flex flex-wrap items-start gap-2">
        <input
          id="min-claude-version"
          name="minClaudeVersion"
          type="text"
          inputMode="decimal"
          placeholder="2.1.0"
          maxLength={20}
          autoComplete="off"
          defaultValue={minClaudeVersion ?? ''}
          className={`${inputClass} w-40 font-mono`}
        />
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="submit"
          name="intent"
          value="clear"
          disabled={pending || !minClaudeVersion}
          className={secondaryButtonClass}
        >
          Clear
        </button>
      </div>
      {state && (
        <p role="status" className={`text-xs ${state.ok ? 'text-good' : 'text-bad'}`}>
          {state.message}
        </p>
      )}
    </form>
  )
}
