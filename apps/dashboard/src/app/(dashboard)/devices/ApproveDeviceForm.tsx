'use client'

import { useActionState } from 'react'
import { approveDeviceAction } from './actions'

export function ApproveDeviceForm() {
  const [state, dispatch, pending] = useActionState(approveDeviceAction, null)

  return (
    <form action={dispatch}>
      <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
        Run <code>burnwatch register</code> on the machine, then type the code it prints.
        Only your own devices can be approved from this account.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            name="code"
            type="text"
            placeholder="ABC123"
            maxLength={6}
            autoComplete="off"
            required
            style={{ width: '160px', padding: '0.75rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text)', fontFamily: 'monospace', letterSpacing: '0.2em', textTransform: 'uppercase' }}
          />
          <button
            type="submit"
            disabled={pending}
            style={{ padding: '0.75rem 1.5rem', background: 'var(--primary)', border: 'none', borderRadius: '4px', color: 'white', cursor: pending ? 'not-allowed' : 'pointer', opacity: pending ? 0.6 : 1 }}
          >
            {pending ? 'Approving...' : 'Approve device'}
          </button>
        </div>
        {state && (
          <p style={{ fontSize: '0.85rem', color: state.ok ? '#22c55e' : '#ef4444' }}>
            {state.message}
          </p>
        )}
      </div>
    </form>
  )
}
