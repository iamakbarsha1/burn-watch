import { cookies } from 'next/headers'
import type {
  OverviewResponse,
  LeaderboardEntry,
  TrendPoint,
  OrgActivitySummary,
  OrgProjectSummary,
} from '@burn-watch/shared'

const API_URL = process.env.API_URL ?? 'http://localhost:3001'

async function apiFetch<T>(path: string): Promise<T> {
  const jar = await cookies()
  const token = jar.get('bw-api-token')?.value

  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store', headers })
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

export async function fetchOverview(date: string, orgId: string): Promise<OverviewResponse> {
  return apiFetch(`/v1/dashboard/overview?date=${date}&orgId=${orgId}`)
}

export async function fetchLeaderboard(date: string, orgId: string): Promise<LeaderboardEntry[]> {
  return apiFetch(`/v1/dashboard/leaderboard?date=${date}&orgId=${orgId}`)
}

export async function fetchTrends(days: number, orgId: string): Promise<TrendPoint[]> {
  return apiFetch(`/v1/dashboard/trends?days=${days}&orgId=${orgId}`)
}

export async function fetchActivity(date: string, orgId: string): Promise<OrgActivitySummary[]> {
  return apiFetch(`/v1/dashboard/activity?date=${date}&orgId=${orgId}`)
}

export async function fetchProjects(date: string, orgId: string): Promise<OrgProjectSummary[]> {
  return apiFetch(`/v1/dashboard/projects?date=${date}&orgId=${orgId}`)
}
