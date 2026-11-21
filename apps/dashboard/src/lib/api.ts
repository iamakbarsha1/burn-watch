import { cookies } from 'next/headers'
import type {
  OverviewResponse,
  LeaderboardEntry,
  TrendPoint,
  ToolUsageSummary,
  OrgProjectSummary,
  AdminUserRow,
  AdminDeviceRow,
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
  if (!res.ok) throw new Error(await errorMessage(res, path))
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

export async function fetchLeaderboard(from: string, to: string, orgId: string): Promise<LeaderboardEntry[]> {
  return apiFetch(`/v1/dashboard/leaderboard?from=${from}&to=${to}&orgId=${orgId}`)
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
