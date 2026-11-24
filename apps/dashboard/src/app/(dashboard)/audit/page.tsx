import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AUDIT_ACTION_PREFIXES, type AuditQuery } from '@burn-watch/shared'
import { fetchAdminUsers, fetchAuditLog } from '@/lib/api'
import { auditSentence } from '@/lib/audit'
import { formatRange, resolveRange } from '@/lib/format'
import { getUserRole } from '@/lib/session'
import { Badge, EmptyRow, PageHeader, TableFrame, Td, Th, Tr, inputClass, secondaryButtonClass } from '@/components/ui'

const PAGE = 100

const KINDS = [
  { value: 'all', label: 'All' },
  { value: 'action', label: 'Changes' },
  { value: 'view', label: 'Views' },
] as const

const AREAS: Record<(typeof AUDIT_ACTION_PREFIXES)[number], string> = {
  'device.': 'Devices',
  'user.': 'Users',
  'invite.': 'Invites',
  'team.': 'Teams',
  'seat.': 'Seats',
  'alert.': 'Alerts',
  'policy.': 'Governance policy',
  'mcp.': 'MCP approvals',
  'org.': 'Organization',
  'copilot.': 'Copilot',
  'view.': 'Views',
}

const linkClass =
  'rounded text-brand underline-offset-4 transition-colors outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/50'

const time = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

type Params = Record<string, string | undefined>

export default async function AuditPage({ searchParams }: { searchParams: Promise<Params> }) {
  const role = await getUserRole()
  if (role !== 'admin') redirect('/')

  const params = await searchParams
  const { from, to } = resolveRange(params)
  const kind = KINDS.some((k) => k.value === params.kind) ? (params.kind as AuditQuery['kind']) : 'all'
  const action = params.action && params.action in AREAS ? (params.action as AuditQuery['action']) : undefined
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0))

  const [rows, users] = await Promise.all([
    fetchAuditLog({ from, to, kind, actorId: params.actorId || undefined, action, limit: PAGE, offset }).catch(() => null),
    fetchAdminUsers().catch(() => []),
  ])
  const names = new Map(users.map((u) => [u.id, u.name]))

  // Paging links keep every other param.
  const pageHref = (next: number) => {
    const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined))
    if (next > 0) q.set('offset', String(next))
    else q.delete('offset')
    return `/audit?${q}`
  }
  const carried = Object.entries(params).filter(
    ([k, v]) => v !== undefined && !['kind', 'actorId', 'action', 'offset'].includes(k),
  )

  return (
    <div>
      <PageHeader
        title="Audit log"
        subtitle={`${formatRange(from, to)} · Changes made by admins and managers, and who opened views that show other people's data. Views are counted once per person, page and day.`}
      />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        {carried.map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label className="text-xs text-ink-2">
          Show
          <select name="kind" defaultValue={kind} className={`${inputClass} mt-1 block`}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-2">
          Person
          <select name="actorId" defaultValue={params.actorId ?? ''} className={`${inputClass} mt-1 block`}>
            <option value="">Anyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-2">
          Area
          <select name="action" defaultValue={action ?? ''} className={`${inputClass} mt-1 block`}>
            <option value="">Everything</option>
            {Object.entries(AREAS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <button type="submit" className={secondaryButtonClass}>
          Filter
        </button>
      </form>

      <TableFrame>
        <table className="w-full">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>What</Th>
              <Th>Target</Th>
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <EmptyRow colSpan={4}>Could not read the audit log. Try again in a moment.</EmptyRow>
            ) : rows.length === 0 ? (
              <EmptyRow colSpan={4}>No events in this range.</EmptyRow>
            ) : (
              rows.map((r) => (
                <Tr key={r.id}>
                  <Td className="whitespace-nowrap text-ink-2">
                    {r.kind === 'view' && r.count > 1
                      ? `${time(r.at)}, first ${clock(r.at)}, ${r.count} times`
                      : time(r.at)}
                  </Td>
                  <Td>
                    <span className="font-medium text-ink">{r.actor.name ?? 'Removed user'}</span>{' '}
                    <Badge>{r.actor.role}</Badge>
                  </Td>
                  <Td>{auditSentence(r, names)}</Td>
                  {/* Org rows written before the API labelled them carry only the org id. */}
                  <Td className="text-ink-2">{r.target.label ?? (r.target.type === 'org' ? 'Organization' : r.target.id) ?? '—'}</Td>
                </Tr>
              ))
            )}
          </tbody>
        </table>
      </TableFrame>

      <div className="mt-4 flex gap-4 text-sm">
        {offset > 0 && (
          <Link href={pageHref(Math.max(0, offset - PAGE))} className={linkClass}>
            Newer events
          </Link>
        )}
        {rows !== null && rows.length === PAGE && (
          <Link href={pageHref(offset + PAGE)} className={linkClass}>
            Load more
          </Link>
        )}
      </div>
    </div>
  )
}
