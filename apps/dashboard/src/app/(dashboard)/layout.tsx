import Link from 'next/link'
import { getSession } from '@/lib/session'
import { SignOutButton } from './SignOutButton'

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/users', label: 'Leaderboard' },
  { href: '/trends', label: 'Trends' },
  { href: '/activity', label: 'Activity' },
  { href: '/projects', label: 'Projects' },
  { href: '/admin', label: 'Admin' },
]

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* Sidebar */}
      <aside style={{ width: '220px', background: 'var(--card)', borderRight: '1px solid var(--border)', padding: '1.5rem 0', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '0 1.5rem', marginBottom: '2rem' }}>
          <span style={{ fontSize: '1.1rem', fontWeight: 700 }}>BurnWatch</span>
        </div>
        <nav style={{ flex: 1 }}>
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              style={{ display: 'block', padding: '0.75rem 1.5rem', color: 'var(--muted)', textDecoration: 'none', fontSize: '0.9rem' }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {session?.user && (
          <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--border)' }}>
            <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.5rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {session.user.email}
            </p>
            <SignOutButton />
          </div>
        )}
      </aside>
      {/* Main content */}
      <main style={{ flex: 1, padding: '2rem', overflow: 'auto' }}>
        {children}
      </main>
    </div>
  )
}
