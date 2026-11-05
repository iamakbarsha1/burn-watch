import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getUserRole } from '@/lib/session'
import { fetchAdminUsers, fetchPendingInvites } from '@/lib/api'
import { formatCost, formatTokens, formatAgo } from '@/lib/format'
import { InviteForm } from './InviteForm'

export default async function AdminPage() {
  const role = await getUserRole()
  if (role !== 'admin') redirect('/')

  // The page is still useful when one of these fails — an admin who cannot
  // reach the API should still see the invite form rather than an error screen.
  const [users, invites] = await Promise.all([
    fetchAdminUsers().catch(() => []),
    fetchPendingInvites().catch(() => []),
  ])

  const onboarded = users.filter((u) => u.deviceCount > 0).length
  const totalSpend = users.reduce((sum, u) => sum + u.totalCostUsd, 0)
  const openInvites = invites.filter((i) => !i.usedAt && new Date(i.expiresAt) > new Date())

  return (
    <div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Admin</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>Manage team members and integrations</p>

      <div style={{ display: 'grid', gap: '1.5rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem' }}>
          <Stat label="Team members" value={String(users.length)} />
          <Stat label="Agent installed" value={`${onboarded} / ${users.length}`} />
          <Stat label="Open invites" value={String(openInvites.length)} />
          <Stat label="All-time spend" value={formatCost(totalSpend)} />
        </div>

        <Section title={`Team (${users.length})`}>
          <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
            Every user in the org, including those who have not installed the agent yet.
            Send them <Link href="/setup" style={{ color: 'var(--primary)' }}>the setup guide</Link>.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Developer', 'Role', 'Status', 'Devices', 'Last sync', 'Days', 'Tokens', 'Spend'].map((h) => (
                    <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>No users yet</td>
                  </tr>
                )}
                {users.map((u) => (
                  <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ fontWeight: 500 }}>{u.name}</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{u.email}</div>
                    </td>
                    <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: 'var(--muted)' }}>{u.role}</td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      {!u.isActive ? (
                        <Badge color="#6b7280">Disabled</Badge>
                      ) : u.deviceCount === 0 ? (
                        <Badge color="#b45309">Not set up</Badge>
                      ) : (
                        <Badge color="#15803d">Active</Badge>
                      )}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem' }}>
                      {u.deviceCount === 0 ? (
                        <span style={{ color: 'var(--muted)' }}>—</span>
                      ) : (
                        <>
                          <div>{u.deviceCount}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{u.hostnames.join(', ')}</div>
                        </>
                      )}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem' }}>
                      <div>{u.lastSyncDate ?? <span style={{ color: 'var(--muted)' }}>never</span>}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{formatAgo(u.lastSeenAt) ?? ''}</div>
                    </td>
                    <td style={{ padding: '0.75rem 1rem', color: 'var(--muted)', fontSize: '0.85rem' }}>{u.activeDays}</td>
                    <td style={{ padding: '0.75rem 1rem', color: 'var(--muted)', fontSize: '0.85rem' }}>{formatTokens(u.totalTokens)}</td>
                    <td style={{ padding: '0.75rem 1rem', fontWeight: 700 }}>{formatCost(u.totalCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Invite Developer">
          <InviteForm />
        </Section>

        {invites.length > 0 && (
          <Section title={`Invites (${invites.length})`}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Email', 'Role', 'Status', 'Expires'].map((h) => (
                    <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => {
                  const expired = new Date(i.expiresAt) <= new Date()
                  return (
                    <tr key={i.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '0.75rem 1rem' }}>{i.email}</td>
                      <td style={{ padding: '0.75rem 1rem', color: 'var(--muted)', fontSize: '0.85rem' }}>{i.role}</td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        {i.usedAt ? <Badge color="#15803d">Accepted</Badge>
                          : expired ? <Badge color="#6b7280">Expired</Badge>
                          : <Badge color="#b45309">Pending</Badge>}
                      </td>
                      <td style={{ padding: '0.75rem 1rem', color: 'var(--muted)', fontSize: '0.85rem' }}>
                        {i.expiresAt.slice(0, 10)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Section>
        )}

        <Section title="GitHub Copilot Integration">
          <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
            Connect your GitHub org to pull Copilot usage data (Business/Enterprise plans only).
          </p>
          <button style={{ padding: '0.75rem 1.5rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text)', cursor: 'pointer' }}>
            Connect GitHub Org
          </button>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>{title}</h2>
      {children}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1rem' }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>{label}</div>
      <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{value}</div>
    </div>
  )
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ background: color, color: 'white', padding: '0.15rem 0.5rem', borderRadius: '999px', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  )
}
