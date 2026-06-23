import { cookies } from 'next/headers'
import type {
  OverviewResponse,
  LeaderboardEntry,
  TrendPoint,
  OrgActivitySummary,
  OrgProjectSummary,
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

export async function fetchActivity(from: string, to: string, orgId: string): Promise<OrgActivitySummary[]> {
  return apiFetch(`/v1/dashboard/activity?from=${from}&to=${to}&orgId=${orgId}`)
}

export async function fetchProjects(from: string, to: string, orgId: string): Promise<OrgProjectSummary[]> {
  return apiFetch(`/v1/dashboard/projects?from=${from}&to=${to}&orgId=${orgId}`)
}

export async function inviteUser(email: string, name: string): Promise<{ userId: string }> {
  return apiPost('/v1/auth/admin/users', { email, name })
}
