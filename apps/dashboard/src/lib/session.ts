import { createHmac } from 'crypto'
import { cookies, headers } from 'next/headers'
import { auth } from './auth'
import { getDb } from './mongo'

const API_JWT_COOKIE = 'bw-api-token'

interface UserRow {
  _id: string
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
  // Case-insensitive on purpose. An admin typing "Dev@acme.com" into the
  // invite form and the developer typing "dev@acme.com" at the login box is
  // the same person, and an exact match here fails sign-in after better-auth
  // has already accepted the password.
  // shortcut: matches stored lowercase emails only (invites lowercase them), use a collated index if mixed-case rows appear.
  const user = await getDb()
    .collection<UserRow>('users')
    .findOne({ email: email.toLowerCase() }, { projection: { orgId: 1, role: 1 } })
  if (!user) return null

  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET not configured')

  const token = signJwt(
    {
      userId: user._id,
      orgId: user.orgId,
      role: user.role,
      sub: user._id,
    },
    secret,
    30 * 24 * 60 * 60, // 30 days
  )

  return { token, orgId: user.orgId, role: user.role }
}

/**
 * Whether an admin has already added this email to BurnWatch. Sign-up is only
 * ever setting a password on an account that exists, so this is the check that
 * keeps the public better-auth endpoint from minting accounts for strangers.
 */
export async function isKnownUserEmail(email: string): Promise<boolean> {
  const user = await getDb()
    .collection('users')
    .findOne({ email: email.toLowerCase(), isActive: true }, { projection: { _id: 1 } })
  return user !== null
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
