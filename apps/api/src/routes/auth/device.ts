import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { users, devices, deviceTokens, organizations } from '../../../drizzle/schema.js'
import { RegisterDeviceSchema } from '@burn-watch/shared'
import type { JwtPayload } from '../../plugins/jwt.js'

const BootstrapSchema = z.object({
  orgName: z.string().min(1),
  orgSlug: z.string().min(1).max(50),
  email: z.string().email(),
  name: z.string().min(1),
})

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  orgId: z.string().uuid().optional(),
})

export async function authRoutes(fastify: FastifyInstance) {
  // POST /v1/auth/register-device
  fastify.post('/register-device', async (request, reply) => {
    const body = RegisterDeviceSchema.parse(request.body)

    // Look up user by email
    const [user] = await fastify.db
      .select({
        id: users.id,
        orgId: users.orgId,
      })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1)

    if (!user) {
      return reply.status(404).send({
        error: 'User not found. Ask your admin to invite you first.',
      })
    }

    // Create device
    const [device] = await fastify.db
      .insert(devices)
      .values({
        userId: user.id,
        hostname: body.hostname,
        platform: body.platform,
        agentVersion: body.agentVersion,
      })
      .returning({ id: devices.id })

    // Sign JWT
    const accessToken = fastify.jwt.sign(
      { deviceId: device.id, userId: user.id, orgId: user.orgId, role: 'device' as const },
      { expiresIn: '30d' },
    )
    const refreshToken = fastify.jwt.sign(
      { deviceId: device.id, userId: user.id, orgId: user.orgId, role: 'device' as const },
      { expiresIn: '90d' },
    )

    // Store token record
    await fastify.db.insert(deviceTokens).values({
      deviceId: device.id,
      tokenHash: accessToken.slice(-16), // simplified hash for MVP
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })

    return {
      accessToken,
      refreshToken,
      deviceId: device.id,
      userId: user.id,
      orgId: user.orgId,
    }
  })

  // POST /v1/auth/refresh
  fastify.post('/refresh', async (request, reply) => {
    try {
      const payload = await request.jwtVerify()
      const accessToken = fastify.jwt.sign(
        {
          deviceId: (payload as any).deviceId,
          userId: (payload as any).userId,
          orgId: (payload as any).orgId,
          role: 'device' as const,
        },
        { expiresIn: '30d' },
      )
      return { accessToken }
    } catch {
      return reply.status(401).send({ error: 'Invalid refresh token' })
    }
  })

  // POST /v1/admin/bootstrap — create org + first admin user (first-run only)
  fastify.post('/admin/bootstrap', async (request, reply) => {
    const existingOrgs = await fastify.db
      .select({ id: organizations.id })
      .from(organizations)
      .limit(1)

    if (existingOrgs.length > 0) {
      return reply.status(403).send({ error: 'Bootstrap already completed. Use /admin/users to add users.' })
    }

    const body = BootstrapSchema.parse(request.body)

    const [org] = await fastify.db
      .insert(organizations)
      .values({
        name: body.orgName,
        slug: body.orgSlug,
      })
      .returning({ id: organizations.id })

    const [user] = await fastify.db
      .insert(users)
      .values({
        orgId: org.id,
        email: body.email,
        name: body.name,
        role: 'admin',
      })
      .returning({ id: users.id })

    return { orgId: org.id, userId: user.id }
  })

  // POST /v1/admin/users — create a user (requires admin JWT)
  fastify.post('/admin/users', {
    preHandler: async (request, reply) => {
      try {
        const payload = await request.jwtVerify<JwtPayload>()
        if (payload.role !== 'admin') {
          return reply.status(403).send({ error: 'Admin role required' })
        }
      } catch {
        return reply.status(401).send({ error: 'Unauthorized' })
      }
    },
  }, async (request, reply) => {
    const body = CreateUserSchema.parse(request.body)
    const jwt = request.user as JwtPayload

    // Admin can only create users in their own org
    const orgId = body.orgId ?? jwt.orgId

    if (orgId !== jwt.orgId) {
      return reply.status(403).send({ error: 'Cannot create users in another organization' })
    }

    const [user] = await fastify.db
      .insert(users)
      .values({
        orgId,
        email: body.email,
        name: body.name,
      })
      .returning({ id: users.id })

    return { userId: user.id }
  })
}
