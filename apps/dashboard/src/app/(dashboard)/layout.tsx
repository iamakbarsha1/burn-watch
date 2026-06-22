import Link from 'next/link'

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/users', label: 'Leaderboard' },
  { href: '/trends', label: 'Trends' },
  { href: '/activity', label: 'Activity' },
  { href: '/projects', label: 'Projects' },
  { href: '/admin', label: 'Admin' },
]

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* Sidebar */}
      <aside style={{ width: '220px', background: 'var(--card)', borderRight: '1px solid var(--border)', padding: '1.5rem 0', flexShrink: 0 }}>
        <div style={{ padding: '0 1.5rem', marginBottom: '2rem' }}>
          <span style={{ fontSize: '1.1rem', fontWeight: 700 }}>BurnWatch</span>
        </div>
        <nav>
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
      </aside>
      {/* Main content */}
      <main style={{ flex: 1, padding: '2rem', overflow: 'auto' }}>
        {children}
      </main>
    </div>
  )
}
