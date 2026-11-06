'use client'

import { useActionState } from 'react'
import { revokeDeviceAction } from './actions'
import { secondaryButtonClass } from '@/components/ui'

export function RevokeDeviceButton({
  deviceId,
  hostname,
  revoked,
}: {
  deviceId: string
  hostname: string
  revoked: boolean
}) {
  const [state, dispatch, pending] = useActionState(revokeDeviceAction, null)

  return (
    <form
      action={dispatch}
      onSubmit={(e) => {
        if (
          !window.confirm(
            `Revoke ${hostname}? It stops reporting usage until someone registers it again.`,
          )
        ) {
          e.preventDefault()
        }
      }}
    >
      <input type="hidden" name="deviceId" value={deviceId} />
      <input type="hidden" name="hostname" value={hostname} />
      <button type="submit" disabled={revoked || pending} className={secondaryButtonClass}>
        {pending ? 'Revoking…' : 'Revoke'}
      </button>

      {state && (
        <p role="status" className={`mt-2 text-xs ${state.ok ? 'text-good' : 'text-bad'}`}>
          {state.message}
        </p>
      )}
    </form>
  )
}
