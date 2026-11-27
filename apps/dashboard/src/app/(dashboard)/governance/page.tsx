import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { fetchClaudeAccounts, fetchFreeTier, fetchMcpInventory, fetchSetupCheckCount, fetchSetupChecks, fetchTeams } from '@/lib/api'
import { nullUnlessTooSmall, unlessTooSmall } from '@/lib/group-too-small'
import { agentById } from '@/lib/agents'
import { FLAG_LABEL } from '@/lib/account-flags'
import { formatRange, formatTokens, resolveRange } from '@/lib/format'
import type { RangeParams } from '@/lib/format'
import { pickTeam } from '@/lib/teams'
import { getUserRole } from '@/lib/session'
import { TeamFilter } from '@/components/TeamFilter'
import { GroupTooSmall, PageHeader, Section, TableFrame, Th, Td, Tr, EmptyRow, Badge } from '@/components/ui'
import { MIN_GROUP_SIZE, type AgentPolicyRule, type ClaudeAccountFlag, type McpServerSource, type SetupCheckReason, type SetupChecksResponse } from '@burn-watch/shared'
import { McpApprovalButton } from './McpApprovalButton'
import { AgentPolicyForm } from './AgentPolicyForm'
import { ClaudeOrgsForm } from './ClaudeOrgsForm'

// Shown whatever the list holds, so an empty list is never read as "nobody
// uses Gemini's free tier". Remove when BW-43 ships.
/** v2 rule 2: a row covering fewer people than this shows its count, not its numbers. */
const SMALL_ROW_NOTE = `A dash means the row covers fewer than ${MIN_GROUP_SIZE} people, so only the count shows.`

const GEMINI_NOTE =
  'Gemini on a personal Google login is free, but it is not detected yet: those rows carry a list-price cost and are not flagged (BW-43).'

const RULE_BADGE: Record<AgentPolicyRule, { tone: 'good' | 'warn' | 'bad' | 'neutral'; label: string }> = {
  allowed: { tone: 'good', label: 'allowed' },
  models: { tone: 'neutral', label: 'listed models only' },
  blocked: { tone: 'bad', label: 'blocked' },
  unset: { tone: 'warn', label: 'not set' },
}

const REASON_LABEL: Record<SetupCheckReason, string> = {
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
  const loaded = await unlessTooSmall(
    Promise.all([
      fetchFreeTier(from, to, team?.id).catch(nullUnlessTooSmall),
      fetchMcpInventory(from, to, team?.id).catch(nullUnlessTooSmall),
      fetchSetupChecks(from, to, team?.id).catch(nullUnlessTooSmall),
      isAdmin ? fetchSetupCheckCount().catch(() => 0) : 0,
      isAdmin ? fetchClaudeAccounts(from, to, team?.id).catch(nullUnlessTooSmall) : undefined,
    ]),
  )
  if (!loaded) {
    // An org under 5 refuses every count, but not the admin's setup checks (v2.1).
    const checks = isAdmin && !team ? await fetchSetupChecks(from, to).catch(() => null) : undefined
    return (
      <div>
        <PageHeader title="Governance" subtitle={formatRange(from, to)} />
        {teams.length > 0 && (
          <Suspense fallback={null}>
            <TeamFilter teams={teams} value={team?.id} />
          </Suspense>
        )}
        <div className="space-y-6">
          <GroupTooSmall />
          {checks !== undefined && <RulesSection checks={checks} isAdmin />}
        </div>
      </div>
    )
  }
  const [data, mcp, checks, setupCheckCount, accounts] = loaded
  const mcpCols = isAdmin ? 8 : 7
  const mcpUnapproved = mcp ? mcp.servers.filter((s) => !s.approved).length : 0

  return (
    <div>
      <PageHeader
        title="Governance"
        subtitle={`${formatRange(from, to)}${team ? ` · team ${team.name}` : ''}`}
      />

      {setupCheckCount > 0 && (
        <div className="mb-4 rounded-lg border border-bad/35 bg-bad/10 px-4 py-3 text-sm text-bad">
          {setupCheckCount === 1 ? '1 setup check' : `${setupCheckCount} setup checks`} in the last 30 days: use of an
          agent or model outside the agent rules. Counted per person, agent and model.
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
        {data && data.people > 0 && (
          <p className="mb-3 text-sm text-ink-2">
            {data.people} {data.people === 1 ? 'person' : 'people'} used a free tier or an unpriced model
          </p>
        )}

        <TableFrame>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Agent · model</Th>
                <Th>Why flagged</Th>
                <Th numeric>People</Th>
                <Th numeric>Days</Th>
                <Th numeric>Tokens</Th>
              </tr>
            </thead>
            <tbody>
              {data === null ? (
                <EmptyRow colSpan={5}>Could not read free-tier usage. Try again in a moment.</EmptyRow>
              ) : data.rows.length === 0 ? (
                <EmptyRow colSpan={5}>No free-tier usage in this range.</EmptyRow>
              ) : (
                data.rows.map((r) => (
                  <Tr key={`${r.agent}:${r.modelName}`}>
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
                    <Td numeric>{r.people}</Td>
                    <Td numeric>{r.days ?? '—'}</Td>
                    <Td numeric>{r.tokens === null ? '—' : formatTokens(r.tokens)}</Td>
                  </Tr>
                ))
              )}
            </tbody>
          </table>
        </TableFrame>
        <p className="mt-3 text-xs text-ink-2">
          &ldquo;Unpriced model&rdquo; means the agent found no price for the model, so it may not
          be a free tier. {SMALL_ROW_NOTE} {GEMINI_NOTE}
        </p>
      </Section>

      {accounts !== undefined && <ClaudeAccountsSection data={accounts} />}

      <RulesSection checks={checks} isAdmin={isAdmin} />

      <Section
        title="MCP servers"
        description="MCP servers can read code and reach outside systems. Approve the ones your org trusts; the rest stay flagged."
      >
        {mcp && mcp.servers.length > 0 && (
          <p className="mb-3 text-sm text-ink-2">
            {mcp.servers.length} {mcp.servers.length === 1 ? 'server' : 'servers'}, {mcpUnapproved} not approved
          </p>
        )}

        <TableFrame>
          <table className="w-full">
            <thead>
              <tr>
                <Th>Server</Th>
                <Th>Source</Th>
                <Th numeric>People</Th>
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
                    <Td numeric>{s.people}</Td>
                    <Td numeric>{s.calls ?? '—'}</Td>
                    <Td numeric>{s.days ?? '—'}</Td>
                    <Td numeric>{s.lastDate ?? '—'}</Td>
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
        <p className="mt-3 text-xs text-ink-2">{SMALL_ROW_NOTE}</p>

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

/** R2 B6. Admins only. Accounts and orgs show as labels; hashes never render. */

/** Agent rules and setup checks. Admins see named rows (v2 decision 2), even in an org under 5 (v2.1). */
function RulesSection({ checks, isAdmin }: { checks: SetupChecksResponse | null; isAdmin: boolean }) {
  return (
    <Section
      title="Agent and model rules"
      description="Which agents and models the org allows. Setup checks below count use outside these rules. Agents with no rule are flagged until an admin sets one."
    >
      {checks === null ? (
        <p className="text-sm text-bad">Could not read the agent rules. Try again in a moment.</p>
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
                {checks.policies.map((p) => (
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
                        <AgentPolicyForm policy={p} seen={checks.seenModels[p.agent] ?? []} />
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </table>
          </TableFrame>

          <h3 className="mt-6 mb-3 text-sm font-medium text-ink">Setup checks</h3>
          <p className="mb-3 text-sm text-ink-2">
            {checks.people === 0
              ? 'Nobody used something outside the rules in this range.'
              : `${checks.people} ${checks.people === 1 ? 'person' : 'people'} used something outside the rules in this range.`}
          </p>
          {isAdmin && checks.rows.length > 0 && (
            <TableFrame>
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>Person</Th>
                    <Th>Teams</Th>
                    <Th>Agent · model</Th>
                    <Th>Why flagged</Th>
                  </tr>
                </thead>
                <tbody>
                  {checks.rows.map((r) => (
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
                    </Tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          )}
          <p className="mt-3 text-xs text-ink-2">
            Usage is checked against the current rules, whenever it happened. Model names match exactly, so a new
            model release is flagged until it is added.
          </p>
        </>
      )}
    </Section>
  )
}

function ClaudeAccountsSection({ data }: { data: Awaited<ReturnType<typeof fetchClaudeAccounts>> | null }) {
  const flags = data ? (Object.keys(FLAG_LABEL) as ClaudeAccountFlag[]).filter((f) => data.flagCounts[f] > 0) : []
  const onCompany = data?.companyOrgUsers ?? 0
  return (
    <Section
      title="Claude accounts"
      description="Which Claude accounts and orgs your people use with Claude Code. BurnWatch only stores hashes of the IDs, so accounts show as labels."
    >
      {data === null ? (
        <p className="text-sm text-bad">Could not read Claude accounts. Try again in a moment.</p>
      ) : (
        <>
          <p className="mb-3 text-sm text-ink-2">
            Account data from {data.coverage.hashed} of {data.coverage.users} Claude Code{' '}
            {data.coverage.users === 1 ? 'user' : 'users'}.
            {data.coverage.hashed < data.coverage.users && ' The rest need agent 0.4 or later.'}
          </p>

          {data.orgs.length > 0 && (
            <>
              {!data.companyOrgSet && (
                <p className="mb-3 text-sm text-ink-2">Mark your company&rsquo;s Claude org to see personal-account use.</p>
              )}
              <ClaudeOrgsForm orgs={data.orgs} />
              <p className="mt-3 text-xs text-ink-2">{SMALL_ROW_NOTE}</p>
            </>
          )}

          {data.companyOrgSet && (
            <p className="mt-4 text-sm text-ink-2">
              {data.seatsEntered > 0 ? (
                `${data.seatsEntered} Claude ${data.seatsEntered === 1 ? 'seat' : 'seats'}. ${onCompany} ${onCompany === 1 ? 'person' : 'people'} seen on the company org.`
              ) : (
                <>
                  No Claude seats entered. <a href="/admin" className="underline">Add seats in Admin</a> to compare.
                </>
              )}
            </p>
          )}

          <div className="mt-4">
            <TableFrame>
              <table className="w-full">
                <thead>
                  <tr>
                    <Th>Note</Th>
                    <Th numeric>People</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.coverage.hashed === 0 ? (
                    <EmptyRow colSpan={2}>No account data in this range.</EmptyRow>
                  ) : flags.length === 0 ? (
                    <EmptyRow colSpan={2}>Nothing to note in this range.</EmptyRow>
                  ) : (
                    flags.map((f) => (
                      <Tr key={f}>
                        <Td>{FLAG_LABEL[f]}</Td>
                        <Td numeric>{data.flagCounts[f]}</Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </table>
            </TableFrame>
          </div>
          <p className="mt-3 text-xs text-ink-2">Each person sees their own notes on My usage.</p>
        </>
      )}
    </Section>
  )
}
