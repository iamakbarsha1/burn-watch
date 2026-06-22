'use client'

import { useActionState } from 'react'
import { inviteAction } from './actions'

export function InviteForm() {
  const [state, dispatch, pending] = useActionState(inviteAction, null)

  return (
    <form action={dispatch}>
      <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
        Invite developers by email. They will run <code>burnwatch register</code> on their machine.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            name="name"
            type="text"
            placeholder="Full name"
            required
            style={{ width: '180px', padding: '0.75rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text)' }}
          />
          <input
            name="email"
            type="email"
            placeholder="developer@company.com"
            required
            style={{ flex: 1, padding: '0.75rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text)' }}
          />
          <button
            type="submit"
            disabled={pending}
            style={{ padding: '0.75rem 1.5rem', background: 'var(--primary)', border: 'none', borderRadius: '4px', color: 'white', cursor: pending ? 'not-allowed' : 'pointer', opacity: pending ? 0.6 : 1 }}
          >
            {pending ? 'Inviting...' : 'Invite'}
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
