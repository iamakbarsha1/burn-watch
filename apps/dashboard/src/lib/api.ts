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

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers = await authHeaders()
  headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    let msg = `API ${path} → ${res.status}`
    try { msg = JSON.parse(text).error ?? msg } catch {}
    throw new Error(msg)
  }
  return res.json() as Promise<T>
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
