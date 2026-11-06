import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getUserRole } from '@/lib/session'
import { fetchAdminUsers, fetchPendingInvites } from '@/lib/api'
import { formatCost, formatTokens, formatAgo } from '@/lib/format'
import { InviteForm } from './InviteForm'
import {
  PageHeader,
  StatTile,
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
      <PageHeader title="Admin" subtitle="Manage team members and integrations" />

      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Team members" value={String(users.length)} />
          <StatTile
            label="Agent installed"
            value={`${onboarded} / ${users.length}`}
            hint={onboarded < users.length ? `${users.length - onboarded} still to set up` : 'everyone reporting'}
          />
          <StatTile label="Open invites" value={String(openInvites.length)} />
          <StatTile label="All-time spend" value={formatCost(totalSpend)} />
        </div>

        <section>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold tracking-tight text-ink">
              Team ({users.length})
            </h2>
            <p className="text-sm text-ink-2">
              Everyone in the org, including those who have not installed the agent. Send
              them{' '}
              <Link href="/setup" className={linkClass}>
                the setup guide
              </Link>
              .
            </p>
          </div>

          <TableFrame>
            <table className="w-full min-w-[920px] border-collapse">
              <thead className="bg-surface-2">
                <tr>
                  <Th>Developer</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Devices</Th>
                  <Th>Last sync</Th>
                  <Th numeric>Days</Th>
                  <Th numeric>Tokens</Th>
                  <Th numeric>Spend</Th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 && <EmptyRow colSpan={8}>No users yet</EmptyRow>}
                {users.map((u) => (
                  <Tr key={u.id}>
                    <Td>
                      <div className="font-medium text-ink">{u.name}</div>
                      <div className="text-xs text-ink-3">{u.email}</div>
                    </Td>
                    <Td className="text-ink-2">{u.role}</Td>
                    <Td>
                      {!u.isActive ? (
                        <Badge tone="neutral">Disabled</Badge>
                      ) : u.deviceCount === 0 ? (
                        <Badge tone="warn">Not set up</Badge>
                      ) : (
                        <Badge tone="good">Active</Badge>
                      )}
                    </Td>
                    <Td>
                      {u.deviceCount === 0 ? (
                        <span className="text-ink-3">—</span>
                      ) : (
                        <>
                          <div className="tabular-nums text-ink">{u.deviceCount}</div>
                          <div className="text-xs text-ink-3">{u.hostnames.join(', ')}</div>
                        </>
                      )}
                    </Td>
                    <Td>
                      <div className="text-ink">
                        {u.lastSyncDate ?? <span className="text-ink-3">never</span>}
                      </div>
                      <div className="text-xs text-ink-3">{formatAgo(u.lastSeenAt) ?? ''}</div>
                    </Td>
                    <Td numeric className="text-ink-2">
                      {u.activeDays}
                    </Td>
                    <Td numeric className="text-ink-2">
                      {formatTokens(u.totalTokens)}
                    </Td>
                    <Td numeric className="font-semibold text-ink">
                      {formatCost(u.totalCostUsd)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        </section>

        <Section
          title="Invite developer"
          description="Creates a link that expires in 7 days. They set their own name and password, then run burnwatch register."
        >
          <InviteForm />
        </Section>

        {invites.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold tracking-tight text-ink">
              Invites ({invites.length})
            </h2>
            <TableFrame>
              <table className="w-full border-collapse">
                <thead className="bg-surface-2">
                  <tr>
                    <Th>Email</Th>
                    <Th>Role</Th>
                    <Th>Status</Th>
                    <Th>Expires</Th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((i) => {
                    const expired = new Date(i.expiresAt) <= new Date()
                    return (
                      <Tr key={i.id}>
                        <Td className="text-ink">{i.email}</Td>
                        <Td className="text-ink-2">{i.role}</Td>
                        <Td>
                          {i.usedAt ? (
                            <Badge tone="good">Accepted</Badge>
                          ) : expired ? (
                            <Badge tone="neutral">Expired</Badge>
                          ) : (
                            <Badge tone="warn">Pending</Badge>
                          )}
                        </Td>
                        <Td className="text-ink-2">{i.expiresAt.slice(0, 10)}</Td>
                      </Tr>
                    )
                  })}
                </tbody>
              </table>
            </TableFrame>
          </section>
        )}

        <Section
          title="GitHub Copilot integration"
          description="Pulling Copilot usage needs a GitHub org connection, which is not built yet. Copilot figures stay at zero until it is. Business and Enterprise plans only."
        >
          <Badge>Not yet available</Badge>
        </Section>
      </div>
    </div>
  )
}
