import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { fetchFreeTier, fetchMcpInventory, fetchTeams, fetchViolationCount, fetchViolations } from '@/lib/api'
import { agentById } from '@/lib/agents'
import { formatRange, formatTokens, resolveRange } from '@/lib/format'
import type { RangeParams } from '@/lib/format'
import { pickTeam } from '@/lib/teams'
import { getUserRole } from '@/lib/session'
import { TeamFilter } from '@/components/TeamFilter'
import { PageHeader, Section, TableFrame, Th, Td, Tr, EmptyRow, Badge } from '@/components/ui'
import type { AgentPolicyRule, McpServerSource, ViolationReason } from '@burn-watch/shared'
import { McpApprovalButton } from './McpApprovalButton'
import { AgentPolicyForm } from './AgentPolicyForm'

// Shown whatever the list holds, so an empty list is never read as "nobody
// uses Gemini's free tier". Remove when BW-43 ships.
const GEMINI_NOTE =
  'Gemini on a personal Google login is free, but it is not detected yet: those rows carry a list-price cost and are not flagged (BW-43).'

const RULE_BADGE: Record<AgentPolicyRule, { tone: 'good' | 'warn' | 'bad' | 'neutral'; label: string }> = {
  allowed: { tone: 'good', label: 'allowed' },
  models: { tone: 'neutral', label: 'listed models only' },
  blocked: { tone: 'bad', label: 'blocked' },
  unset: { tone: 'warn', label: 'not set' },
}

const REASON_LABEL: Record<ViolationReason, string> = {
  'agent-blocked': 'agent blocked',
  'agent-not-set': 'agent not set',
  'model-not-listed': 'model not listed',
}

const SOURCE_LABEL: Record<McpServerSource, string> = {
  plugin: 'Claude Code plugin',
  'claude.ai': 'claude.ai connector',
  local: 'local config',
  unnamed: 'no readable name',
}

export default async function GovernancePage({
  searchParams,
}: {
  searchParams: Promise<RangeParams & { teamId?: string }>
}) {
  const role = await getUserRole()
  if (role !== 'admin' && role !== 'manager') redirect('/')

  const params = await searchParams
  const { from, to } = resolveRange(params)
  const teams = await fetchTeams().catch(() => [])
  const team = pickTeam(teams, params.teamId)
  const isAdmin = role === 'admin'
  const [data, mcp, violations, violationCount] = await Promise.all([
    fetchFreeTier(from, to, team?.id).catch(() => null),
    fetchMcpInventory(from, to, team?.id).catch(() => null),
    fetchViolations(from, to, team?.id).catch(() => null),
    isAdmin ? fetchViolationCount().catch(() => 0) : 0,
  ])
  const mcpCols = isAdmin ? 8 : 7
  const mcpPeople = mcp ? new Set(mcp.servers.flatMap((s) => s.users.map((u) => u.userId))).size : 0
  const mcpUnapproved = mcp ? mcp.servers.filter((s) => !s.approved).length : 0

  return (
    <div>
      <PageHeader
        title="Governance"
        subtitle={`${formatRange(from, to)}${team ? ` · team ${team.name}` : ''}`}
      />

      {violationCount > 0 && (
        <div className="mb-4 rounded-lg border border-bad/35 bg-bad/10 px-4 py-3 text-sm text-bad">
          {violationCount === 1
            ? '1 use of an agent or model outside the policy in the last 30 days.'
            : `${violationCount} uses of an agent or model outside the policy in the last 30 days.`}{' '}
          Counted per person, agent and model.
        </div>
      )}

      {teams.length > 0 && (
        <Suspense fallback={null}>
          <TeamFilter teams={teams} value={team?.id} />
        </Suspense>
      )}

      <Section
        title="Free-tier usage"
        description="Free tiers may let the provider train on what is sent to them, including company or client code. Check each provider's terms."
      >
        {data && data.byTeam.length > 0 && (
          <p className="mb-3 text-sm text-ink-2">
            {data.byTeam
              .map(
                (t) =>
                  `${t.teamName ?? 'No team'}: ${t.users} ${t.users === 1 ? 'person' : 'people'}, ${formatTokens(t.tokens)} tokens`,
              )
              .join(' · ')}
          </p>
        )}

        <TableFrame>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Teams</Th>
                <Th>Agent · model</Th>
                <Th>Why flagged</Th>
                <Th numeric>Days</Th>
                <Th numeric>Tokens</Th>
                <Th numeric>Last seen</Th>
              </tr>
            </thead>
            <tbody>
              {data === null ? (
                <EmptyRow colSpan={7}>Could not read free-tier usage. Try again in a moment.</EmptyRow>
              ) : data.rows.length === 0 ? (
                <EmptyRow colSpan={7}>No free-tier usage in this range.</EmptyRow>
              ) : (
                data.rows.map((r) => (
                  <Tr key={`${r.userId}:${r.agent}:${r.modelName}`}>
                    <Td>
                      <div className="font-medium text-ink">{r.userName ?? 'Removed user'}</div>
                      {r.userEmail && <div className="text-xs text-ink-2">{r.userEmail}</div>}
                    </Td>
                    <Td className="text-ink-2">{r.teams.length ? r.teams.join(', ') : '—'}</Td>
                    <Td>
                      {agentById(r.agent)?.label ?? r.agent} · <span className="text-ink-2">{r.modelName}</span>
                    </Td>
                    <Td>
                      {r.reason === 'free-tier-agent' ? (
                        <Badge tone="warn">free-tier agent</Badge>
                      ) : (
                        <Badge>unpriced model</Badge>
                      )}
                    </Td>
                    <Td numeric>{r.days}</Td>
                    <Td numeric>{formatTokens(r.tokens)}</Td>
                    <Td numeric>{r.lastDate}</Td>
                  </Tr>
                ))
              )}
            </tbody>
          </table>
        </TableFrame>
        <p className="mt-3 text-xs text-ink-2">
          &ldquo;Unpriced model&rdquo; means the agent found no price for the model, so it may not
          be a free tier. {GEMINI_NOTE}
        </p>
      </Section>

      <Section
        title="Agent and model policy"
        description="Which agents and models the org allows. Usage outside the policy is listed below. Agents with no rule are flagged until an admin sets one."
      >
        {violations === null ? (
          <p className="text-sm text-bad">Could not read the policy. Try again in a moment.</p>
        ) : (
          <>
            <TableFrame>
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>Agent</Th>
                    <Th>Rule</Th>
                    <Th>Allowed models</Th>
                    <Th>Note</Th>
                    {isAdmin && <Th>Change</Th>}
                  </tr>
                </thead>
                <tbody>
                  {violations.policies.map((p) => (
                    <Tr key={p.agent}>
                      <Td className="font-medium text-ink">{agentById(p.agent)?.label ?? p.agent}</Td>
                      <Td>
                        <Badge tone={RULE_BADGE[p.rule].tone}>{RULE_BADGE[p.rule].label}</Badge>
                      </Td>
                      <Td className="font-mono text-xs text-ink-2">
                        {p.rule === 'models' ? p.models.join(', ') : p.rule === 'allowed' ? 'any' : '—'}
                      </Td>
                      <Td className="text-ink-2">{p.note ?? '—'}</Td>
                      {isAdmin && (
                        <Td>
                          <AgentPolicyForm policy={p} seen={violations.seenModels[p.agent] ?? []} />
                        </Td>
                      )}
                    </Tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>

            <h3 className="mt-6 mb-3 text-sm font-medium text-ink">Usage outside the policy</h3>
            {violations.byTeam.length > 0 && (
              <p className="mb-3 text-sm text-ink-2">
                {violations.byTeam
                  .map(
                    (t) =>
                      `${t.teamName ?? 'No team'}: ${t.users} ${t.users === 1 ? 'person' : 'people'}, ${formatTokens(t.tokens)} tokens`,
                  )
                  .join(' · ')}
              </p>
            )}
            <TableFrame>
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>Person</Th>
                    <Th>Teams</Th>
                    <Th>Agent · model</Th>
                    <Th>Why flagged</Th>
                    <Th numeric>Days</Th>
                    <Th numeric>Tokens</Th>
                    <Th numeric>Last seen</Th>
                  </tr>
                </thead>
                <tbody>
                  {violations.rows.length === 0 ? (
                    <EmptyRow colSpan={7}>No usage outside the policy in this range.</EmptyRow>
                  ) : (
                    violations.rows.map((r) => (
                      <Tr key={`${r.userId}:${r.agent}:${r.modelName}`}>
                        <Td>
                          <div className="font-medium text-ink">{r.userName ?? 'Removed user'}</div>
                          {r.userEmail && <div className="text-xs text-ink-2">{r.userEmail}</div>}
                        </Td>
                        <Td className="text-ink-2">{r.teams.length ? r.teams.join(', ') : '—'}</Td>
                        <Td>
                          {agentById(r.agent)?.label ?? r.agent} · <span className="text-ink-2">{r.modelName}</span>
                        </Td>
                        <Td>
                          <Badge tone={r.reason === 'agent-blocked' ? 'bad' : 'warn'}>{REASON_LABEL[r.reason]}</Badge>
                        </Td>
                        <Td numeric>{r.days}</Td>
                        <Td numeric>{formatTokens(r.tokens)}</Td>
                        <Td numeric>{r.lastDate}</Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </table>
            </TableFrame>
            <p className="mt-3 text-xs text-ink-2">
              Usage is checked against the current policy, whenever it happened. Model names match exactly, so a new
              model release is flagged until it is added.
            </p>
          </>
        )}
      </Section>

      <Section
        title="MCP servers"
        description="MCP servers can read code and reach outside systems. Approve the ones your org trusts; the rest stay flagged."
      >
        {mcp && mcp.servers.length > 0 && (
          <p className="mb-3 text-sm text-ink-2">
            {mcp.servers.length} {mcp.servers.length === 1 ? 'server' : 'servers'}, {mcpUnapproved} not approved, used
            by {mcpPeople} {mcpPeople === 1 ? 'person' : 'people'}
          </p>
        )}

        <TableFrame>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Server</Th>
                <Th>Source</Th>
                <Th>People</Th>
                <Th numeric>Calls</Th>
                <Th numeric>Days</Th>
                <Th numeric>Last seen</Th>
                <Th>Status</Th>
                {isAdmin && <Th>Action</Th>}
              </tr>
            </thead>
            <tbody>
              {mcp === null ? (
                <EmptyRow colSpan={mcpCols}>Could not read MCP usage. Try again in a moment.</EmptyRow>
              ) : mcp.servers.length === 0 ? (
                <EmptyRow colSpan={mcpCols}>No MCP server calls in this range.</EmptyRow>
              ) : (
                mcp.servers.map((s) => (
                  <Tr key={s.server}>
                    <Td>
                      <div className="font-mono text-sm text-ink">{s.server}</div>
                      {s.note && <div className="text-xs text-ink-2">{s.note}</div>}
                    </Td>
                    <Td className="text-ink-2">{SOURCE_LABEL[s.source]}</Td>
                    <Td className="text-ink-2">{s.users.map((u) => u.name ?? 'Removed user').join(', ')}</Td>
                    <Td numeric>{s.calls}</Td>
                    <Td numeric>{s.days}</Td>
                    <Td numeric>{s.lastDate}</Td>
                    <Td>{s.approved ? <Badge tone="good">approved</Badge> : <Badge tone="warn">not approved</Badge>}</Td>
                    {isAdmin && (
                      <Td>
                        <McpApprovalButton server={s.server} approved={s.approved} />
                      </Td>
                    )}
                  </Tr>
                ))
              )}
            </tbody>
          </table>
        </TableFrame>

        {mcp && mcp.unusedApprovals.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-sm text-ink-2">Approved, but not called in this range:</p>
            <ul className="space-y-2">
              {mcp.unusedApprovals.map((a) => (
                <li key={a.server} className="flex items-center gap-3">
                  <span className="font-mono text-sm text-ink">{a.server}</span>
                  {a.note && <span className="text-xs text-ink-2">{a.note}</span>}
                  {isAdmin && <McpApprovalButton server={a.server} approved />}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-3 text-xs text-ink-2">
          Only Claude Code is covered. Names come from each developer&rsquo;s own config, so one service can show
          under several names, and each name is approved on its own.
        </p>
      </Section>
    </div>
  )
}
