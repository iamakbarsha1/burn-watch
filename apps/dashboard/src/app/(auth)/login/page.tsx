'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { mintApiToken } from './actions'
import { AuthCard, Field, authLinkClass } from '../auth-ui'
import { buttonClass } from '@/components/ui'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const { error: authError } = await authClient.signIn.email({
        email,
        password,
      })

      if (authError) {
        setError(authError.message ?? 'Sign in failed')
        setLoading(false)
        return
      }

      // Mint Fastify-compatible API token and set as httpOnly cookie
      const tokenResult = await mintApiToken(email)
      if (!tokenResult.success) {
        setError(tokenResult.error ?? 'Failed to create API session')
        setLoading(false)
        return
      }

      router.push('/')
      router.refresh()
    } catch {
      setError('Something went wrong. Try again.')
      setLoading(false)
    }
  }

  return (
    <AuthCard
      title="BurnWatch"
      subtitle="Sign in to your dashboard"
      error={error}
      footer={
        <>
          First time?{' '}
          <Link href="/signup" className={authLinkClass}>
            Set your password
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field
          id="email"
          label="Email"
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
          placeholder="••••••••"
          autoComplete="current-password"
          required
          disabled={loading}
        />
        <button type="submit" disabled={loading} className={`${buttonClass} w-full`}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthCard>
  )
}
