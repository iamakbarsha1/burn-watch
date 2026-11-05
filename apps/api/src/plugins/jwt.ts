import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
// Aliased so the namespace augmentation below can name the type. A bare `JWT`
// there is the interface being merged, which declaration emit rejects (TS4033).
import type { JWT as JwtInstance } from '@fastify/jwt'

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

export function requireAuth(fastify: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.accessJwtVerify<JwtPayload>()
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
