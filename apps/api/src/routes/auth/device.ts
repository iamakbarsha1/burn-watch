import type { FastifyInstance } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { eq, and, isNull, gt } from 'drizzle-orm'
import { users, devices, deviceTokens, organizations, pendingDevices } from '../../../drizzle/schema.js'
import { RegisterDeviceSchema, VerifyDeviceSchema } from '@burn-watch/shared'
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

function generateCode(): string {
  // 6-char uppercase alphanumeric
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I to avoid confusion
  const bytes = randomBytes(6)
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

export async function authRoutes(fastify: FastifyInstance) {
  // POST /v1/auth/register-device — step 1: create pending device, return verification code
  fastify.post('/register-device', async (request, reply) => {
    const body = RegisterDeviceSchema.parse(request.body)

    // Look up user by email
    const [user] = await fastify.db
      .select({ id: users.id, orgId: users.orgId })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1)

    if (!user) {
      return reply.status(404).send({
        error: 'User not found. Ask your admin to invite you first.',
      })
    }

    // Create pending device with 15-minute expiry
    const code = generateCode()
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

    const [pending] = await fastify.db
      .insert(pendingDevices)
      .values({
        code,
        email: body.email,
        hostname: body.hostname,
        platform: body.platform,
        agentVersion: body.agentVersion,
        expiresAt,
      })
      .returning({ id: pendingDevices.id })

    return {
      pendingId: pending.id,
      code,
      expiresAt: expiresAt.toISOString(),
    }
  })

  // POST /v1/auth/verify-device — step 2: verify code, create device + tokens
  fastify.post('/verify-device', async (request, reply) => {
    const body = VerifyDeviceSchema.parse(request.body)

    // Find pending device that matches code + pendingId, not expired, not yet verified
    const [pending] = await fastify.db
      .select()
      .from(pendingDevices)
      .where(
        and(
          eq(pendingDevices.id, body.pendingId),
          eq(pendingDevices.code, body.code),
          isNull(pendingDevices.verifiedAt),
          gt(pendingDevices.expiresAt, new Date()),
        ),
      )
      .limit(1)

    if (!pending) {
      return reply.status(400).send({
        error: 'Invalid or expired verification code',
      })
    }

    // Look up user
    const [user] = await fastify.db
      .select({ id: users.id, orgId: users.orgId })
      .from(users)
      .where(eq(users.email, pending.email))
      .limit(1)

    if (!user) {
      return reply.status(404).send({ error: 'User no longer exists' })
    }

    // Create device
    const [device] = await fastify.db
      .insert(devices)
      .values({
        userId: user.id,
        hostname: pending.hostname,
        platform: pending.platform,
        agentVersion: pending.agentVersion,
      })
      .returning({ id: devices.id })

    // Mark pending as verified
    await fastify.db
      .update(pendingDevices)
      .set({ verifiedAt: new Date(), deviceId: device.id })
      .where(eq(pendingDevices.id, pending.id))

    // Sign JWT tokens
    const tokenPayload = { deviceId: device.id, userId: user.id, orgId: user.orgId, role: 'device' as const }
    const accessToken = fastify.jwt.access.sign(tokenPayload, { expiresIn: '30d' })
    const refreshToken = fastify.jwt.refresh.sign(tokenPayload, { expiresIn: '90d' })

    // Store token hash for revocation
    const tokenHash = createHash('sha256').update(accessToken).digest('hex')
    await fastify.db.insert(deviceTokens).values({
      deviceId: device.id,
      tokenHash,
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

  // POST /v1/auth/refresh — verify with refresh secret, issue new access token
  fastify.post('/refresh', async (request, reply) => {
    try {
      const payload = await request.jwtVerify<JwtPayload>({ namespace: 'refresh' })
      const accessToken = fastify.jwt.access.sign(
        {
          deviceId: payload.deviceId,
          userId: payload.userId,
          orgId: payload.orgId,
          role: payload.role,
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
        const payload = await request.jwtVerify<JwtPayload>({ namespace: 'access' })
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
