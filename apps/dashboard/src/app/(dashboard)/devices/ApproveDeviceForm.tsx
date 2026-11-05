'use client'

import { useActionState } from 'react'
import { approveDeviceAction } from './actions'
import { inputClass, buttonClass } from '@/components/ui'

export function ApproveDeviceForm() {
  const [state, dispatch, pending] = useActionState(approveDeviceAction, null)

  return (
    <form action={dispatch}>
      <p className="mb-4 text-sm text-ink-2">
        Run <code className="rounded bg-surface-0 px-1 py-0.5 font-mono text-xs text-ink">burnwatch register</code>{' '}
        on the machine, then type the code it prints. Only your own devices can be approved
        from this account.
      </p>

      <div className="flex flex-wrap items-start gap-2">
        <div>
          <label className="sr-only" htmlFor="device-code">
            Device code
          </label>
          <input
            id="device-code"
            name="code"
            type="text"
            placeholder="ABC123"
            maxLength={6}
            autoComplete="off"
            required
            aria-describedby={state ? 'device-code-status' : undefined}
            className={`${inputClass} w-40 font-mono tracking-[0.25em] uppercase`}
          />
        </div>
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? 'Approving…' : 'Approve device'}
        </button>
      </div>

      {state && (
        <p
          id="device-code-status"
          role="status"
          className={`mt-3 text-sm ${state.ok ? 'text-good' : 'text-bad'}`}
        >
          {state.message}
        </p>
      )}
    </form>
  )
}
