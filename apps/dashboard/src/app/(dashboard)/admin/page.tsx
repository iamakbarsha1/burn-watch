export default function AdminPage() {
  return (
    <div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Admin</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>Manage team members and integrations</p>

      <div style={{ display: 'grid', gap: '1.5rem' }}>
        <Section title="Invite Developer">
          <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
            Invite developers by email. They will run <code>burnwatch register</code> on their machine.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="email"
              placeholder="developer@company.com"
              style={{ flex: 1, padding: '0.75rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text)' }}
            />
            <button style={{ padding: '0.75rem 1.5rem', background: 'var(--primary)', border: 'none', borderRadius: '4px', color: 'white', cursor: 'pointer' }}>
              Invite
            </button>
          </div>
        </Section>

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
