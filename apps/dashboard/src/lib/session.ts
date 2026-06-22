import { createHmac } from 'crypto'
import { cookies, headers } from 'next/headers'
import { Pool } from '@neondatabase/serverless'
import { auth } from './auth'

const API_JWT_COOKIE = 'bw-api-token'

interface BurnWatchUser {
  id: string
  orgId: string
  role: string
}

export async function getSession() {
  return auth.api.getSession({
    headers: await headers(),
  })
}

export async function getApiToken(): Promise<string | null> {
  const jar = await cookies()
  return jar.get(API_JWT_COOKIE)?.value ?? null
}

export async function getOrgId(): Promise<string | null> {
  const jar = await cookies()
  const token = jar.get(API_JWT_COOKIE)?.value
  if (!token) return null
  try {
    const [, payload] = token.split('.')
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return decoded.orgId ?? null
  } catch {
    return null
  }
}

export async function getUserRole(): Promise<string | null> {
  const jar = await cookies()
  const token = jar.get(API_JWT_COOKIE)?.value
  if (!token) return null
  try {
    const [, payload] = token.split('.')
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return decoded.role ?? null
  } catch {
    return null
  }
}

function signJwt(payload: Record<string, unknown>, secret: string, expiresInSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const body = Buffer.from(
    JSON.stringify({ ...payload, iat: now, exp: now + expiresInSec }),
  ).toString('base64url')
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url')
  return `${header}.${body}.${signature}`
}

interface ApiTokenResult {
  token: string
  orgId: string
  role: string
}

export async function createApiTokenForEmail(email: string): Promise<ApiTokenResult | null> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
  try {
    const result = await pool.query<BurnWatchUser>(
      'SELECT id, org_id AS "orgId", role FROM users WHERE email = $1 LIMIT 1',
      [email],
    )
    if (result.rows.length === 0) return null

    const user = result.rows[0]
    const secret = process.env.JWT_SECRET
    if (!secret) throw new Error('JWT_SECRET not configured')

    const token = signJwt(
      {
        userId: user.id,
        orgId: user.orgId,
        role: user.role,
        sub: user.id,
      },
      secret,
      30 * 24 * 60 * 60, // 30 days
    )

    return { token, orgId: user.orgId, role: user.role }
  } finally {
    await pool.end()
  }
}

export async function setApiTokenCookie(token: string) {
  const jar = await cookies()
  jar.set(API_JWT_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  })
}

export async function clearApiTokenCookie() {
  const jar = await cookies()
  jar.delete(API_JWT_COOKIE)
}
