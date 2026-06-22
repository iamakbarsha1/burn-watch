'use client'

import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { signOutAction } from '../(auth)/login/actions'

export function SignOutButton() {
  const router = useRouter()

  async function handleSignOut() {
    await authClient.signOut()
    await signOutAction()
    router.push('/login')
    router.refresh()
  }

  return (
    <button
      onClick={handleSignOut}
      style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '0.8rem', padding: 0 }}
    >
      Sign out
    </button>
  )
}
