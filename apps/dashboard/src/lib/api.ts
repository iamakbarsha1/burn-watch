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
} from '@burn-watch/shared'

const API_URL = process.env.API_URL ?? 'http://localhost:3001'

async function authHeaders(): Promise<Record<string, string>> {
  const jar = await cookies()
  const token = jar.get('bw-api-token')?.value
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

async function apiFetch<T>(path: string): Promise<T> {
  const headers = await authHeaders()
  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store', headers })
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`)
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
  if (!res.ok) {
    const text = await res.text()
    let msg = `API ${path} → ${res.status}`
    try { msg = JSON.parse(text).error ?? msg } catch {}
    throw new Error(msg)
  }
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

export async function fetchOverview(from: string, to: string, orgId: string): Promise<OverviewResponse> {
  return apiFetch(`/v1/dashboard/overview?from=${from}&to=${to}&orgId=${orgId}`)
}

export async function fetchLeaderboard(from: string, to: string, orgId: string): Promise<LeaderboardEntry[]> {
  return apiFetch(`/v1/dashboard/leaderboard?from=${from}&to=${to}&orgId=${orgId}`)
}

export async function fetchTrends(from: string, to: string, orgId: string): Promise<TrendPoint[]> {
  return apiFetch(`/v1/dashboard/trends?from=${from}&to=${to}&orgId=${orgId}`)
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
  // `apiMutate` directly rather than a one-caller `apiPut` wrapper: PUT has
  // exactly this one use in the dashboard.
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
