import Link from 'next/link'
import { AGENT_FIELDS_VERSION, UPDATE_AGENT_VERSION, type AdminDeviceRow } from '@burn-watch/shared'
import { getUserRole } from '@/lib/session'
import { fetchAdminDevices, fetchDeviceSettings } from '@/lib/api'
import { formatAgo } from '@/lib/format'
import { deviceVersionStatus, versionSummary } from '@/lib/versions'
import { ApproveDeviceForm } from './ApproveDeviceForm'
import { DeviceSettingsForm } from './DeviceSettingsForm'
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

const linkClass =
  'rounded text-brand underline-offset-4 transition-colors outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/50'

export default async function DevicesPage() {
  // Gated by rendering rather than by redirect, the way /admin does it. This
  // page is also where a developer approves their own machine, so sending a
  // non-admin away would cost them the one thing they come here for.
  const isAdmin = (await getUserRole()) === 'admin'
  const [devices, settings] = isAdmin
    ? await Promise.all([
        fetchAdminDevices().catch((): AdminDeviceRow[] => []),
        fetchDeviceSettings().catch(() => ({ minClaudeVersion: null })),
      ])
    : [[], { minClaudeVersion: null }]
  const min = settings.minClaudeVersion
  const summary = versionSummary(devices, min)

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
          <Section
            title="Claude Code minimum"
            description="Devices on an older Claude Code version are flagged below. Leave it empty to flag none."
          >
            <DeviceSettingsForm minClaudeVersion={min} />
          </Section>
        )}

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

            <p className="mb-3 text-sm text-ink-2">
              Agent {UPDATE_AGENT_VERSION}+: {summary.agentCurrent} of {summary.active} active devices.{' '}
              {min ? `Below the Claude Code minimum: ${summary.below}.` : 'No minimum set.'} Unknown:{' '}
              {summary.unknown}.
            </p>

            <TableFrame>
              <table className="w-full min-w-[960px] border-collapse">
                <thead className="bg-surface-2">
                  <tr>
                    <Th>Device</Th>
                    <Th>Owner</Th>
                    <Th>Last seen</Th>
                    <Th>Claude Code</Th>
                    <Th>Agent</Th>
                    <Th>Status</Th>
                    <Th>Access</Th>
                  </tr>
                </thead>
                <tbody>
                  {devices.length === 0 && <EmptyRow colSpan={7}>No devices registered yet</EmptyRow>}
                  {devices.map((d) => {
                    const v = deviceVersionStatus(d, min)
                    return (
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
                          {v.claude === 'unknown' ? (
                            <span className="text-ink-3">Unknown (agent before {AGENT_FIELDS_VERSION})</span>
                          ) : v.claude === 'none' ? (
                            <span className="text-ink-3">No Claude Code use</span>
                          ) : (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-ink">{d.claudeVersion}</span>
                              {v.claude === 'below' && <Badge tone="warn">Below {min}</Badge>}
                            </div>
                          )}
                        </Td>
                        <Td>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-ink">{d.agentVersion}</span>
                            {v.updateAgent && <Badge tone="warn">Update agent</Badge>}
                          </div>
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
                    )
                  })}
                </tbody>
              </table>
            </TableFrame>

            <p className="mt-3 text-sm text-ink-2">
              &ldquo;Update agent&rdquo; means the machine runs an agent older than {UPDATE_AGENT_VERSION}. Older
              agents need node to collect usage, and agents before {AGENT_FIELDS_VERSION} do not report
              versions. Its owner can run <code className="font-mono">burnwatch update</code> or follow{' '}
              <Link href="/setup" className={linkClass}>
                the setup guide
              </Link>{' '}
              to rebuild it.
            </p>
          </section>
        )}
      </div>
    </div>
  )
}
