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
      type="button"
      onClick={handleSignOut}
      className="mt-1 rounded text-xs text-ink-3 transition-colors outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/50"
    >
      Sign out
    </button>
  )
}
