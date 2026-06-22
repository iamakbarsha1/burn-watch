import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

export interface JwtPayload {
  deviceId: string
  userId: string
  orgId: string
  role: 'device' | 'user'
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload
    user: JwtPayload
  }
}

export function requireAuth(fastify: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify<JwtPayload>({ namespace: 'access' })
    } catch {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  }
}

export function requireDashboardAuth(fastify: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await request.jwtVerify<JwtPayload>({ namespace: 'access' })
      if (payload.role !== 'user' && payload.role !== 'admin') {
        return reply.status(403).send({ error: 'Dashboard access requires user or admin role' })
      }
    } catch {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  }
}
