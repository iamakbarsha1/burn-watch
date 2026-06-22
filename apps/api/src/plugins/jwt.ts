import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

export interface JwtPayload {
  deviceId?: string
  userId: string
  orgId: string
  role: 'device' | 'admin' | 'manager' | 'developer'
}

declare module 'fastify' {
  interface FastifyInstance {
    jwt: {
      access: { sign: (payload: Record<string, unknown>, options?: { expiresIn: string }) => string }
      refresh: { sign: (payload: Record<string, unknown>, options?: { expiresIn: string }) => string }
    }
  }
  interface FastifyRequest {
    accessJwtVerify: <T = JwtPayload>(options?: Record<string, unknown>) => Promise<T>
    refreshJwtVerify: <T = JwtPayload>(options?: Record<string, unknown>) => Promise<T>
    user: JwtPayload
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
