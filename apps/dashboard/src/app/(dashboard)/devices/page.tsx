import { ApproveDeviceForm } from './ApproveDeviceForm'

export default function DevicesPage() {
  return (
    <div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Devices</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>Approve a machine before it can report usage</p>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>Approve a device</h2>
        <ApproveDeviceForm />
      </div>
    </div>
  )
}
