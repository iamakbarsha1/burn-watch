'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { mintApiToken } from './actions'

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
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', padding: '2rem', borderRadius: '8px', width: '400px' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>BurnWatch</h1>
        <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>Sign in to your dashboard</p>

        {error && (
          <div style={{ background: '#7f1d1d', border: '1px solid #991b1b', padding: '0.75rem', borderRadius: '4px', marginBottom: '1rem', fontSize: '0.875rem' }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.875rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ width: '100%', padding: '0.75rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text)' }}
              placeholder="you@company.com"
              required
              disabled={loading}
            />
          </div>
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', fontSize: '0.875rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ width: '100%', padding: '0.75rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text)' }}
              placeholder="••••••••"
              required
              disabled={loading}
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            style={{ width: '100%', padding: '0.75rem', background: loading ? '#6b21a8' : 'var(--primary)', border: 'none', borderRadius: '4px', color: 'white', fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer' }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
