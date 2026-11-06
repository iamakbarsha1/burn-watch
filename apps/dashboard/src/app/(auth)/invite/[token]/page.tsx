'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { acceptInviteAction } from './actions'
import { mintApiToken } from '../../login/actions'
import { AuthCard, Field, authLinkClass } from '../../auth-ui'
import { buttonClass } from '@/components/ui'

export default function AcceptInvitePage() {
  const router = useRouter()
  const params = useParams<{ token: string }>()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      // Redeeming the invite has to come first: the sign-up endpoint only
      // accepts an email that already has a BurnWatch user, and this is the
      // call that creates one.
      const accepted = await acceptInviteAction(params.token, name)
      if (!accepted.ok) {
        setError(accepted.error)
        setLoading(false)
        return
      }

      const { error: authError } = await authClient.signUp.email({
        name,
        email: accepted.email,
        password,
      })

      if (authError) {
        // The invite is spent but the account exists, so /signup is the way
        // back in rather than a dead end.
        setError(
          `${authError.message ?? 'Could not set your password'}. Your account is created — set a password at /signup using ${accepted.email}.`,
        )
        setLoading(false)
        return
      }

      const tokenResult = await mintApiToken(accepted.email)
      if (!tokenResult.success) {
        setError(tokenResult.error ?? 'Failed to create API session')
        setLoading(false)
        return
      }

      router.push('/setup')
      router.refresh()
    } catch {
      setError('Something went wrong. Try again.')
      setLoading(false)
    }
  }

  return (
    <AuthCard
      title="BurnWatch"
      subtitle="You have been invited. Pick a name and a password to finish."
      error={error}
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className={authLinkClass}>
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field
          id="name"
          label="Name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoComplete="name"
          required
          disabled={loading}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          autoComplete="new-password"
          minLength={8}
          required
          disabled={loading}
        />
        <button type="submit" disabled={loading} className={`${buttonClass} w-full`}>
          {loading ? 'Setting up…' : 'Accept invite'}
        </button>
      </form>
    </AuthCard>
  )
}
