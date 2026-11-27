import { cache } from 'react'
import { GroupTooSmallError } from './group-too-small'
import { cookies } from 'next/headers'
import type {
  OverviewResponse,
  MyUsageResponse,
  UsageDistributionResponse,
  TrendPoint,
  ToolUsageSummary,
  OrgProjectSummary,
  AdminUserRow,
  AdminDeviceRow,
  DeviceSettings,
  PendingInvite,
  BudgetAlert,
  BudgetAlertInput,
  BudgetAlertPatch,
  CopilotStatus,
  CopilotSyncResult,
  CopilotSeatsResponse,
  Team,
  TeamComparison,
  Seat,
  SeatInput,
  SeatAssignAll,
  AgentName,
  FreeTierResponse,
  SetupChecksResponse,
  AgentPolicyInput,
  McpInventoryResponse,
  UnusedSeatsResponse,
  FeatureMatrixResponse,
  OnboardingResponse,
  PracticeRank,
  PracticesResponse,
  ClaudeAccountsResponse,
  TicketUsageResponse,
  FunnelResponse,
  AuditRow,
  AuditQuery,
  AuditMeResponse,
} from '@burn-watch/shared'

const API_URL = process.env.API_URL ?? 'http://localhost:3001'

async function authHeaders(): Promise<Record<string, string>> {
  const jar = await cookies()
  const token = jar.get('bw-api-token')?.value
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

/**
 * The API's own words when it sent any, the bare status when it did not.
 *
 * Every route answers a failure with `{ error }`, and those sentences are
 * written for the operator: "Credential encryption is not configured" sends
 * them to their config, where "→ 503" sends them nowhere. Reads used to drop
 * the body and report only the status, so the four distinct errors the Copilot
 * routes take care to tell apart all arrived at the panel as the same number.
 */
async function errorMessage(res: Response, path: string): Promise<string> {
  const fallback = `API ${path} → ${res.status}`
  try {
    return JSON.parse(await res.text()).error ?? fallback
  } catch {
    return fallback
  }
}

async function apiFetch<T>(path: string): Promise<T> {
  const headers = await authHeaders()
  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store', headers })
  if (!res.ok) {
    const message = await errorMessage(res, path)
    if (res.status === 403 && message === 'group_too_small') throw new GroupTooSmallError(message)
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

// The content type is only declared when there is something to declare it for.
// Fastify rejects an empty body that claims to be JSON with a 400, so setting
// the header unconditionally broke every bodyless DELETE before it reached a
// route handler.
async function apiMutate<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = await authHeaders()
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(await errorMessage(res, path))
  // A 204 carries no body, and `res.json()` on an empty one throws a
  // SyntaxError that reads like a network fault. DELETE /copilot/connection
  // answers 204; this keeps the next bodyless route from rediscovering it.
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiMutate<T>('POST', path, body)
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiMutate<T>('PATCH', path, body)
}

async function apiDelete<T>(path: string): Promise<T> {
  return apiMutate<T>('DELETE', path)
}

// `teamId` narrows the read to one team. The API answers 403/404 for a team the
// viewer cannot read, so pages pass only ids that came back from fetchTeams.
const teamQuery = (teamId?: string) => (teamId ? `&teamId=${teamId}` : '')

export async function fetchOverview(
  from: string,
  to: string,
  orgId: string,
  teamId?: string,
): Promise<OverviewResponse> {
  return apiFetch(`/v1/dashboard/overview?from=${from}&to=${to}&orgId=${orgId}${teamQuery(teamId)}`)
}

// Any role. The caller's own numbers only; the API takes the user from the token.
export async function fetchMyUsage(from: string, to: string): Promise<MyUsageResponse> {
  return apiFetch(`/v1/dashboard/me/usage?from=${from}&to=${to}`)
}

// Any role. Sets only the caller's own "happy to help with Claude Code".
export async function setHelpVolunteer(helpVolunteer: boolean): Promise<{ helpVolunteer: boolean }> {
  return apiMutate('PUT', '/v1/dashboard/me/help-volunteer', { helpVolunteer })
}

// Admin or manager. Counts per band, no names; 403 group_too_small under MIN_GROUP_SIZE people.
export async function fetchUsageDistribution(from: string, to: string, teamId?: string): Promise<UsageDistributionResponse> {
  return apiFetch(`/v1/dashboard/usage-distribution?from=${from}&to=${to}${teamQuery(teamId)}`)
}

export async function fetchTrends(
  from: string,
  to: string,
  orgId: string,
  teamId?: string,
): Promise<TrendPoint[]> {
  return apiFetch(`/v1/dashboard/trends?from=${from}&to=${to}&orgId=${orgId}${teamQuery(teamId)}`)
}

export async function fetchActivity(from: string, to: string, orgId: string): Promise<ToolUsageSummary[]> {
  return apiFetch(`/v1/dashboard/activity?from=${from}&to=${to}&orgId=${orgId}`)
}

export async function fetchProjects(from: string, to: string, orgId: string): Promise<OrgProjectSummary[]> {
  return apiFetch(`/v1/dashboard/projects?from=${from}&to=${to}&orgId=${orgId}`)
}

export async function fetchAdminUsers(): Promise<AdminUserRow[]> {
  return apiFetch('/v1/auth/admin/users')
}

/** Deletes the person and all their data, login included. Admin only; never the caller. */
export async function deleteUser(userId: string): Promise<{ userId: string }> {
  return apiDelete(`/v1/auth/admin/users/${userId}`)
}

export async function fetchPendingInvites(): Promise<PendingInvite[]> {
  return apiFetch('/v1/auth/admin/invites')
}

// The plaintext token comes back exactly once and is never stored, so whatever
// shows it to the admin is the only chance to hand it to the invitee.
export async function createInvite(
  email: string,
  role: string,
): Promise<{ inviteId: string; email: string; role: string; token: string; expiresAt: string }> {
  return apiPost('/v1/auth/admin/invites', { email, role })
}

export type BulkInviteResult =
  | { ok: true; email: string; role: string; token: string; expiresAt: string }
  | { ok: false; email: string; error: string }

export async function createInvites(
  rows: { email: string; role?: string; team?: string }[],
): Promise<{ results: BulkInviteResult[] }> {
  return apiPost('/v1/auth/admin/invites/bulk', { rows })
}

export async function acceptInvite(
  token: string,
  name: string,
): Promise<{ userId: string; orgId: string; email: string; role: string }> {
  return apiPost('/v1/auth/invites/accept', { token, name })
}

export async function approveDevice(code: string): Promise<{ hostname: string; platform: string }> {
  return apiPost('/v1/auth/approve-device', { code })
}

export async function fetchAdminDevices(): Promise<AdminDeviceRow[]> {
  return apiFetch('/v1/auth/admin/devices')
}

export async function fetchDeviceSettings(): Promise<DeviceSettings> {
  return apiFetch('/v1/auth/admin/device-settings')
}

// Admin only; the API answers 403 to anyone else.
export async function updateDeviceSettings(input: DeviceSettings): Promise<DeviceSettings> {
  return apiMutate('PUT', '/v1/auth/admin/device-settings', input)
}

export async function revokeDevice(deviceId: string): Promise<{ deviceId: string; revoked: number }> {
  return apiPost('/v1/auth/admin/devices/revoke', { deviceId })
}

export async function fetchBudgetAlerts(): Promise<BudgetAlert[]> {
  return apiFetch('/v1/dashboard/budget-alerts')
}

export async function createBudgetAlert(input: BudgetAlertInput): Promise<{ id: string }> {
  return apiPost('/v1/dashboard/budget-alerts', input)
}

export async function updateBudgetAlert(id: string, patch: BudgetAlertPatch): Promise<{ id: string }> {
  return apiPatch(`/v1/dashboard/budget-alerts/${id}`, patch)
}

export async function deleteBudgetAlert(id: string): Promise<{ id: string }> {
  return apiDelete(`/v1/dashboard/budget-alerts/${id}`)
}

export async function fetchCopilotStatus(): Promise<CopilotStatus> {
  return apiFetch('/v1/integrations/copilot/status')
}

// The token goes up and is never seen again. Nothing in the response carries
// it back, not even a prefix, so there is nothing here to be careful with
// afterwards.
export async function connectCopilot(
  org: string,
  token: string,
): Promise<{ connected: true; org: string }> {
  // `apiMutate` directly rather than an `apiPut` wrapper: PUT has few uses in
  // the dashboard (this, setTeamMember, setSeat), not enough to earn one.
  return apiMutate('PUT', '/v1/integrations/copilot/connection', { org, token })
}

// 204, so there is no body. `apiMutate` returns undefined for one.
export async function disconnectCopilot(): Promise<void> {
  return apiDelete('/v1/integrations/copilot/connection')
}

// `day` omitted means yesterday UTC, which the API picks. Today is never a
// sensible default: GitHub has usually not generated the report yet, and the
// sync would quietly write nothing.
export async function syncCopilot(day?: string): Promise<CopilotSyncResult> {
  return apiPost('/v1/integrations/copilot/sync', day ? { day } : {})
}

// Every call walks the org's whole seat roster at GitHub, so this belongs
// behind a button rather than on a page load. `idleAfterDays` omitted leaves
// the window to the API, which uses 30.
export async function fetchCopilotSeats(idleAfterDays?: number): Promise<CopilotSeatsResponse> {
  const query = idleAfterDays === undefined ? '' : `?idleAfterDays=${idleAfterDays}`
  return apiFetch(`/v1/integrations/copilot/seats${query}`)
}

/* ---------- Teams (R0.2) ---------- */

// Every team for an admin, managed teams for a manager, [] for a developer.
export async function fetchTeams(): Promise<Team[]> {
  return apiFetch('/v1/dashboard/teams')
}

export async function fetchTeamCompare(from: string, to: string): Promise<TeamComparison[]> {
  return apiFetch(`/v1/dashboard/teams/compare?from=${from}&to=${to}`)
}

export async function createTeam(name: string): Promise<{ id: string }> {
  return apiPost('/v1/dashboard/teams', { name })
}

export async function renameTeam(id: string, name: string): Promise<{ id: string }> {
  return apiPatch(`/v1/dashboard/teams/${id}`, { name })
}

export async function deleteTeam(id: string): Promise<{ id: string }> {
  return apiDelete(`/v1/dashboard/teams/${id}`)
}

// Adds the user, or changes their role when they are already in the team.
export async function setTeamMember(
  teamId: string,
  userId: string,
  role: 'manager' | 'member',
): Promise<{ teamId: string; userId: string; role: string }> {
  return apiMutate('PUT', `/v1/dashboard/teams/${teamId}/members/${userId}`, { role })
}

export async function removeTeamMember(teamId: string, userId: string): Promise<{ teamId: string; userId: string }> {
  return apiDelete(`/v1/dashboard/teams/${teamId}/members/${userId}`)
}

/* ---------- Seats (R0.1) ---------- */

// B1. Admins get the org, managers their own teams; a developer gets 403.
export async function fetchFreeTier(from: string, to: string, teamId?: string): Promise<FreeTierResponse> {
  return apiFetch(`/v1/dashboard/governance/free-tier?from=${from}&to=${to}${teamQuery(teamId)}`)
}

export async function fetchSetupChecks(from: string, to: string, teamId?: string): Promise<SetupChecksResponse> {
  return apiFetch(`/v1/dashboard/governance/setup-checks?from=${from}&to=${to}${teamQuery(teamId)}`)
}

/**
 * Setup checks (use outside the agent rules) in the last 30 days, admins only. Cached per request: the
 * layout's nav count and a page's banner share one call.
 */
export const fetchSetupCheckCount = cache(async (): Promise<number> => {
  return (await apiFetch<{ count: number }>('/v1/dashboard/governance/setup-checks/count')).count
})

export async function setAgentPolicy(agent: AgentName, input: AgentPolicyInput): Promise<{ agent: AgentName }> {
  return apiMutate('PUT', `/v1/dashboard/governance/agent-policy/${agent}`, input)
}

export async function clearAgentPolicy(agent: AgentName): Promise<{ agent: AgentName }> {
  return apiDelete(`/v1/dashboard/governance/agent-policy/${agent}`)
}

export async function fetchMcpInventory(from: string, to: string, teamId?: string): Promise<McpInventoryResponse> {
  return apiFetch(`/v1/dashboard/governance/mcp?from=${from}&to=${to}${teamQuery(teamId)}`)
}

export async function fetchTickets(from: string, to: string): Promise<TicketUsageResponse> {
  return apiFetch(`/v1/dashboard/tickets?from=${from}&to=${to}`)
}

export async function setTicketPrefixes(prefixes: string[]): Promise<{ prefixes: string[] }> {
  return apiMutate('PUT', '/v1/dashboard/tickets/settings', { prefixes })
}

export async function fetchClaudeAccounts(from: string, to: string, teamId?: string): Promise<ClaudeAccountsResponse> {
  return apiFetch(`/v1/dashboard/governance/accounts?from=${from}&to=${to}${teamQuery(teamId)}`)
}

export async function setCompanyClaudeOrgs(ids: string[]): Promise<{ count: number }> {
  return apiMutate('PUT', '/v1/dashboard/governance/claude-orgs', { ids })
}

// Admins only; a manager gets 403.
export async function fetchUnusedSeats(idleDays: number, teamId?: string): Promise<UnusedSeatsResponse> {
  return apiFetch(`/v1/dashboard/adoption/unused-seats?idleDays=${idleDays}${teamQuery(teamId)}`)
}

export async function fetchFunnel(from: string, to: string, teamId?: string): Promise<FunnelResponse> {
  return apiFetch(`/v1/dashboard/adoption/funnel?from=${from}&to=${to}${teamQuery(teamId)}`)
}

// R2 A5. Admin or manager, same scope as the funnel.
export async function fetchFeatures(from: string, to: string, teamId?: string): Promise<FeatureMatrixResponse> {
  return apiFetch(`/v1/dashboard/adoption/features?from=${from}&to=${to}${teamQuery(teamId)}`)
}

// R2 D6. New people in range and whether they got going.
export async function fetchOnboarding(from: string, to: string, teamId?: string): Promise<OnboardingResponse> {
  return apiFetch(`/v1/dashboard/adoption/onboarding?from=${from}&to=${to}${teamQuery(teamId)}`)
}

// R2 A6. Aggregates only; the API names no one.
export async function fetchPractices(from: string, to: string, rankBy: PracticeRank, teamId?: string): Promise<PracticesResponse> {
  return apiFetch(`/v1/dashboard/adoption/practices?from=${from}&to=${to}&rankBy=${rankBy}${teamQuery(teamId)}`)
}

// R1 B8. Admin only; the API answers newest first.
export async function fetchAuditLog(q: AuditQuery): Promise<AuditRow[]> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v))
  return apiFetch(`/v1/dashboard/audit?${params}`)
}

// v2 Phase 4. Any role: who viewed data that covered the caller. Defaults to the last 90 days.
export async function fetchAuditMe(from?: string, to?: string): Promise<AuditMeResponse> {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  return apiFetch(`/v1/dashboard/audit/me?${params}`)
}

// The key goes in the body or query, never the path: it comes from a
// developer's config and may hold a `/`.
export async function approveMcpServer(server: string, note: string | null): Promise<{ server: string }> {
  return apiMutate('PUT', '/v1/dashboard/governance/mcp-approvals', { server, note })
}

export async function revokeMcpServer(server: string): Promise<{ server: string }> {
  return apiDelete(`/v1/dashboard/governance/mcp-approvals?server=${encodeURIComponent(server)}`)
}

export async function fetchSeats(): Promise<Seat[]> {
  return apiFetch('/v1/dashboard/seats')
}

// Adds the seat, or changes its price and start date when it already exists.
export async function setSeat(
  userId: string,
  agent: AgentName,
  input: SeatInput,
): Promise<{ userId: string; agent: AgentName }> {
  return apiMutate('PUT', `/v1/dashboard/seats/${userId}/${agent}`, input)
}

export async function removeSeat(userId: string, agent: AgentName): Promise<{ userId: string; agent: AgentName }> {
  return apiDelete(`/v1/dashboard/seats/${userId}/${agent}`)
}

// Never overwrites an existing seat; `created` counts only the new ones.
export async function assignSeatToAll(input: SeatAssignAll): Promise<{ created: number }> {
  return apiPost('/v1/dashboard/seats/assign-all', input)
}
