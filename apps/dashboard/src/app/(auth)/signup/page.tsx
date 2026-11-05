'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { mintApiToken } from '../login/actions'
import { AuthCard, Field, authLinkClass } from '../auth-ui'
import { buttonClass } from '@/components/ui'

export default function SignupPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const { error: authError } = await authClient.signUp.email({ name, email, password })

      if (authError) {
        setError(authError.message ?? 'Could not create your password')
        setLoading(false)
        return
      }

      // Sign-up already leaves a session, so the API token is the last step
      // before the dashboard will load.
      const tokenResult = await mintApiToken(email)
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
      subtitle="Set a password for the account your admin created."
      error={error}
      footer={
        <>
          Already set one?{' '}
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
          id="email"
          label="Work email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
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
          {loading ? 'Creating…' : 'Create password'}
        </button>
      </form>
    </AuthCard>
  )
}
