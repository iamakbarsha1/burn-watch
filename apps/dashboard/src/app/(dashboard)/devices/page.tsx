import { getUserRole } from '@/lib/session'
import { fetchAdminDevices } from '@/lib/api'
import { formatAgo } from '@/lib/format'
import { ApproveDeviceForm } from './ApproveDeviceForm'
import { RevokeDeviceButton } from './RevokeDeviceButton'
import {
  PageHeader,
  Section,
  TableFrame,
  Th,
  Td,
  Tr,
  EmptyRow,
  Badge,
} from '@/components/ui'

export default async function DevicesPage() {
  // Gated by rendering rather than by redirect, the way /admin does it. This
  // page is also where a developer approves their own machine, so sending a
  // non-admin away would cost them the one thing they come here for.
  const isAdmin = (await getUserRole()) === 'admin'
  const devices = isAdmin ? await fetchAdminDevices().catch(() => []) : []

  return (
    <div className={isAdmin ? '' : 'max-w-2xl'}>
      <PageHeader
        title="Devices"
        subtitle="Approve a machine before it can report usage"
      />

      <div className="space-y-6">
        <Section title="Approve a device">
          <ApproveDeviceForm />
        </Section>

        {isAdmin && (
          <section>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold tracking-tight text-ink">
                Registered devices ({devices.length})
              </h2>
              <p className="text-sm text-ink-2">
                Revoking ends every token the machine holds. Use it when a laptop is lost
                or its owner leaves.
              </p>
            </div>

            <TableFrame>
              <table className="w-full min-w-[720px] border-collapse">
                <thead className="bg-surface-2">
                  <tr>
                    <Th>Device</Th>
                    <Th>Owner</Th>
                    <Th>Last seen</Th>
                    <Th>Status</Th>
                    <Th>Access</Th>
                  </tr>
                </thead>
                <tbody>
                  {devices.length === 0 && <EmptyRow colSpan={5}>No devices registered yet</EmptyRow>}
                  {devices.map((d) => (
                    <Tr key={d.id}>
                      <Td>
                        <div className="font-medium text-ink">{d.hostname}</div>
                        <div className="text-xs text-ink-3">{d.platform}</div>
                      </Td>
                      <Td>
                        <div className="text-ink">{d.userName}</div>
                        <div className="text-xs text-ink-3">{d.userEmail}</div>
                      </Td>
                      <Td className="text-ink-2">
                        {formatAgo(d.lastSeenAt) ?? <span className="text-ink-3">never</span>}
                      </Td>
                      <Td>
                        {d.revoked ? (
                          <Badge tone="neutral">Revoked</Badge>
                        ) : (
                          <Badge tone="good">Active</Badge>
                        )}
                      </Td>
                      <Td>
                        <RevokeDeviceButton
                          deviceId={d.id}
                          hostname={d.hostname}
                          revoked={d.revoked}
                        />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          </section>
        )}
      </div>
    </div>
  )
}
