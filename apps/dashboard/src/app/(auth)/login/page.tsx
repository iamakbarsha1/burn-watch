'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // TODO: integrate better-auth
    // For MVP: mock admin login
    if (email && password) {
      router.push('/')
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', padding: '2rem', borderRadius: '8px', width: '400px' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>BurnWatch</h1>
        <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>Sign in to your dashboard</p>
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
            />
          </div>
          <button type="submit" style={{ width: '100%', padding: '0.75rem', background: 'var(--primary)', border: 'none', borderRadius: '4px', color: 'white', fontWeight: 600, cursor: 'pointer' }}>
            Sign In
          </button>
        </form>
      </div>
    </div>
  )
}
