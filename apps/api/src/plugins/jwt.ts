import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
// Aliased so the namespace augmentation below can name the type. A bare `JWT`
// there is the interface being merged, which declaration emit rejects (TS4033).
import type { JWT as JwtInstance } from '@fastify/jwt'
import { MIN_GROUP_SIZE } from '@burn-watch/shared'
import { getStore, type DeviceId, type OrgId, type TeamDoc, type TeamId, type UserId } from '@burn-watch/db'

export interface JwtPayload {
  deviceId?: string
  userId: string
  orgId: string
  role: 'device' | 'admin' | 'manager' | 'developer'
}

// @fastify/jwt already declares `jwt` on FastifyInstance and `user` on FastifyRequest.
// Redeclaring them here conflicts (TS2717) and collapses request.user to
// `string | object | Buffer`. Augment its own interfaces instead: it derives both
// SignPayloadType and UserType from FastifyJWT.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload
    user: JwtPayload
  }

  // server.ts registers two instances under namespaces 'access' and 'refresh'.
  // At runtime the plugin hangs each one on fastify.jwt[namespace].
  interface JWT {
    access: JwtInstance
    refresh: JwtInstance
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    // A namespaced registration renames the verifier to `${namespace}JwtVerify`.
    accessJwtVerify: <T = JwtPayload>(options?: Record<string, unknown>) => Promise<T>
    refreshJwtVerify: <T = JwtPayload>(options?: Record<string, unknown>) => Promise<T>
  }
}

/**
 * Whether the device still holds an unrevoked `deviceTokens` document.
 *
 * `revokedAt: null` is the whole filter, and the missing half matters.
 * There is deliberately no `expiresAt > now` term: that field is written
 * once at registration as now + 30 days and never updated, while
 * POST /v1/auth/refresh mints a fresh 30-day access token without inserting a
 * new document. An expiry term here would 401 every legitimately refreshing
 * device on day 31. Expiry is the JWT `exp` claim's job, and accessJwtVerify
 * has already checked it by the time this runs.
 */
export async function deviceTokenIsLive(deviceId: string | undefined): Promise<boolean> {
  if (!deviceId) return false
  const live = await getStore().deviceTokens.findOne(
    { deviceId: deviceId as DeviceId, revokedAt: null },
    { projection: { _id: 1 } },
  )
  return live !== null
}

export function requireAuth(fastify: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await request.accessJwtVerify<JwtPayload>()
      // Only a device token has a `deviceTokens` document. An unconditional lookup
      // would 401 every dashboard request. Inside the try so a database
      // failure answers 401 rather than a 500 from the global error handler.
      // That makes an outage fail closed, and the cost is bounded: the agent
      // throws on any non-ok response and never re-registers, so a dead
      // database costs the fleet one skipped sync that the next run resends.
      if (payload.role === 'device' && !(await deviceTokenIsLive(payload.deviceId))) {
        return reply.status(401).send({ error: 'Unauthorized' })
      }
    } catch {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  }
}

// Every admin-only route repeated this same try/verify/check-role block. One
// copy means a route added later cannot forget the 401-vs-403 distinction.
export function requireAdmin(fastify: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await request.accessJwtVerify<JwtPayload>()
      if (payload.role !== 'admin') {
        return reply.status(403).send({ error: 'Admin role required' })
      }
    } catch {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  }
}

/**
 * The users a dashboard read is limited to, or undefined for the whole org.
 * Admins see the org, managers see themselves plus every member of each team
 * they manage, everyone else sees only themselves. Every dashboard query must
 * apply this, or a developer can read the org's spend by calling the API
 * directly, whatever the sidebar hides.
 *
 * Read per request, so a team change applies on the next call. The JWT role is
 * the gate: a 'manager' team row on a developer widens nothing.
 */
export async function viewerScope(user: JwtPayload): Promise<UserId[] | undefined> {
  if (user.role === 'admin') return undefined
  const self = user.userId as UserId
  if (user.role !== 'manager') return [self]

  // orgId on both reads, so a row written against another org can never widen scope.
  const orgId = user.orgId as OrgId
  const store = getStore()
  const managed = await store.teamMembers.find({ orgId, userId: self, role: 'manager' })
  if (managed.length === 0) return [self]
  const members = await store.teamMembers.find({ orgId, teamId: { $in: managed.map((m) => m.teamId) } })
  return [...new Set([self, ...members.map((m) => m.userId)])]
}

/**
 * The users a read filtered to one team is limited to.
 *
 * 404 when the team is not in the caller's org. 403 when the caller may not
 * read it: a manager asking for a team they do not manage gets an error, never
 * an empty intersection that renders as a team with zero spend. A plain member
 * of the team (developer or manager) still sees only themselves.
 */
export async function teamScope(user: JwtPayload, teamId: TeamId): Promise<UserId[] | 403 | 404> {
  const orgId = user.orgId as OrgId
  const store = getStore()
  const team = await store.teams.findOne({ _id: teamId, orgId })
  if (!team) return 404
  const members = await store.teamMembers.find({ orgId, teamId })
  const ids = members.map((m) => m.userId)
  if (user.role === 'admin') return ids

  const mine = members.find((m) => m.userId === user.userId)
  if (!mine) return 403
  return user.role === 'manager' && mine.role === 'manager' ? ids : [mine.userId]
}

/** Why a scoped read was refused. 403 and 404 are teamScope's; see `refuse`. */
export type ScopeRefusal = 403 | 404 | 'too_small'

/**
 * viewerScope, narrowed to one team when the request names one, and refused
 * as `too_small` when it covers other people but fewer than MIN_GROUP_SIZE of
 * them. A scope of just the caller is their own data and always allowed.
 * Undefined (an admin's whole org) is not counted here.
 */
export async function readScope(user: JwtPayload, teamId?: string): Promise<UserId[] | undefined | ScopeRefusal> {
  const scope = teamId ? await teamScope(user, teamId as TeamId) : await viewerScope(user)
  if (!Array.isArray(scope)) return scope
  const self = scope.length === 1 && scope[0] === user.userId
  return !self && new Set(scope).size < MIN_GROUP_SIZE ? 'too_small' : scope
}

/** Teams the viewer may compare: every team for an admin, managed teams for a manager. */
export async function comparableTeams(user: JwtPayload): Promise<TeamDoc[]> {
  const orgId = user.orgId as OrgId
  const store = getStore()
  if (user.role === 'admin') return store.teams.find({ orgId }, { sort: { name: 1 } })
  if (user.role !== 'manager') return []
  const managed = await store.teamMembers.find({ orgId, userId: user.userId as UserId, role: 'manager' })
  if (managed.length === 0) return []
  return store.teams.find({ orgId, _id: { $in: managed.map((m) => m.teamId) } }, { sort: { name: 1 } })
}

export function requireDashboardAuth(fastify: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await request.accessJwtVerify<JwtPayload>()
      if (payload.role !== 'admin' && payload.role !== 'manager' && payload.role !== 'developer') {
        return reply.status(403).send({ error: 'Dashboard access requires user role' })
      }
    } catch {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  }
}
