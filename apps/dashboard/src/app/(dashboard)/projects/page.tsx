import { redirect } from 'next/navigation'
import { fetchProjects } from '@/lib/api'
import { formatCost, formatRange, resolveRange, formatCount } from '@/lib/format'
import { getOrgId } from '@/lib/session'
import { PageHeader, TableFrame, Th, Td, Tr, EmptyRow } from '@/components/ui'

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>
}) {
  const { from, to } = resolveRange(await searchParams)

  const orgId = await getOrgId()
  if (!orgId) redirect('/login')

  let projects: Awaited<ReturnType<typeof fetchProjects>> = []
  try {
    projects = await fetchProjects(from, to, orgId)
  } catch {
    // Show empty state if API unavailable
  }

  projects.sort((a, b) => b.totalCost - a.totalCost)
  const top = projects[0]?.totalCost ?? 0

  return (
    <div>
      <PageHeader
        title="Project Breakdown"
        subtitle={`${formatRange(from, to)} · AI spend by internal project`}
      />

      <TableFrame>
        <table className="w-full border-collapse">
          <thead className="bg-surface-2">
            <tr>
              <Th>Project</Th>
              <Th numeric>Total cost</Th>
              <Th numeric>Sessions</Th>
              <Th numeric>Avg / session</Th>
              <Th numeric>Users</Th>
            </tr>
          </thead>
          <tbody>
            {projects.length === 0 && (
              <EmptyRow colSpan={5}>
                No project data. This needs codeburn enrichment from the agent.
              </EmptyRow>
            )}
            {projects.map((p) => (
              <Tr key={p.path}>
                <Td>
                  <div className="font-mono text-xs text-ink">{p.path}</div>
                  {/* Share of the top project, so the eye can rank without
                      reading every figure. */}
                  <div className="mt-1.5 h-1 w-full max-w-40 overflow-hidden rounded-full bg-surface-0">
                    <div
                      className="h-full rounded-full bg-brand"
                      style={{ width: `${top > 0 ? (p.totalCost / top) * 100 : 0}%` }}
                    />
                  </div>
                </Td>
                <Td numeric className="font-semibold text-ink">
                  {formatCost(p.totalCost)}
                </Td>
                <Td numeric className="text-ink-2">
                  {formatCount(p.totalSessions)}
                </Td>
                <Td numeric className="text-ink-2">
                  {formatCost(p.avgCostPerSession)}
                </Td>
                <Td numeric className="text-ink-2">
                  {p.userCount}
                </Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </div>
  )
}
