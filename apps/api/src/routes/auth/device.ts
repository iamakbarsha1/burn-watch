import type { FastifyInstance } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { eq, and, isNull, isNotNull, gt, sql } from 'drizzle-orm'
import { users, devices, deviceTokens, organizations, pendingDevices, dailySnapshots } from '../../../drizzle/schema.js'
import { RegisterDeviceSchema, VerifyDeviceSchema, ApproveDeviceSchema } from '@burn-watch/shared'
import type { AdminUserRow } from '@burn-watch/shared'
import { requireAdmin, requireDashboardAuth, type JwtPayload } from '../../plugins/jwt.js'

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

/**
 * A calendar day as `YYYY-MM-DD`. The query casts to text so this normally gets
 * a string, but a driver that parses `date` itself hands back local midnight,
 * and `toISOString` on that lands on the previous day anywhere east of UTC.
 * Reading the local parts keeps the day the database meant.
 */
function toDateString(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${value.getFullYear()}-${month}-${day}`
  }
  return String(value).slice(0, 10)
}

function generateCode(): string {
  // 6-char uppercase alphanumeric
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I to avoid confusion
  const bytes = randomBytes(6)
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

export async function authRoutes(fastify: FastifyInstance) {
  // POST /v1/auth/register-device — step 1: create pending device, return verification code
  fastify.post('/register-device', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
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

  // POST /v1/auth/approve-device — the human step: a signed-in user claims a
  // code their own agent printed. This is what makes registration more than a
  // guess at someone's work email, so the endpoint must stay authenticated.
  fastify.post('/approve-device', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    preHandler: requireDashboardAuth(fastify),
  }, async (request, reply) => {
    const body = ApproveDeviceSchema.parse(request.body)
    const jwt = request.user as JwtPayload

    const [user] = await fastify.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, jwt.userId))
      .limit(1)

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    // One UPDATE decides and records the approval, so two clicks on the same
    // code cannot both win. Matching on the signed-in user's own email is the
    // actual control: approving is only ever possible for your own device.
    const [approved] = await fastify.db
      .update(pendingDevices)
      .set({ approvedAt: new Date() })
      .where(
        and(
          eq(pendingDevices.code, body.code),
          eq(pendingDevices.email, user.email),
          isNull(pendingDevices.approvedAt),
          isNull(pendingDevices.verifiedAt),
          gt(pendingDevices.expiresAt, new Date()),
        ),
      )
      .returning({ hostname: pendingDevices.hostname, platform: pendingDevices.platform })

    // Unknown, expired, already approved, already used, or someone else's code
    // all answer the same way, so this cannot be used to probe for live codes.
    if (!approved) {
      return reply.status(400).send({ error: 'Invalid or expired verification code' })
    }

    return { hostname: approved.hostname, platform: approved.platform }
  })

  // POST /v1/auth/verify-device — step 3: exchange an approved code for tokens
  //
  // The cap is high because the agent polls this endpoint every 10s for up to
  // 15 minutes while it waits for the approval above, and @fastify/rate-limit
  // keys on IP — a whole office behind one NAT shares the budget. Nothing is
  // lost by that: reaching this route at all needs the pendingId, a v4 UUID
  // handed only to the caller that registered, so the cap is a DoS backstop
  // and never the thing standing between a guess and a token.
  // ponytail: raise the cap if an office ever trips it; key on pendingId
  // (config.rateLimit.hook = 'preHandler') only if that stops being enough.
  fastify.post('/verify-device', {
    config: { rateLimit: { max: 600, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = VerifyDeviceSchema.parse(request.body)

    // Find pending device that matches code + pendingId, approved in the
    // dashboard, not expired, not yet verified
    const [pending] = await fastify.db
      .select()
      .from(pendingDevices)
      .where(
        and(
          eq(pendingDevices.id, body.pendingId),
          eq(pendingDevices.code, body.code),
          isNotNull(pendingDevices.approvedAt),
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
      const payload = await request.refreshJwtVerify<JwtPayload>()
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

  // POST /v1/auth/admin/bootstrap — create org + first admin user (first-run only)
  fastify.post('/admin/bootstrap', {
    config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
  }, async (request, reply) => {
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

  // GET /v1/auth/admin/users — every user in the caller's org, including the
  // ones who have never synced. The leaderboard cannot answer this: it reads
  // from daily_snapshots, so a developer with no data simply is not in it, and
  // "who has not onboarded yet" is exactly what an admin needs to see.
  fastify.get('/admin/users', { preHandler: requireAdmin(fastify) }, async (request) => {
    const jwt = request.user as JwtPayload

    // Correlated subqueries rather than joins. Joining devices and snapshots in
    // one statement multiplies rows, and every SUM would come back wrong by the
    // number of devices the user owns.
    const rows = await fastify.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        isActive: users.isActive,
        createdAt: users.createdAt,
        deviceCount: sql<number>`(
          select count(*) from ${devices} where ${devices.userId} = ${users.id}
        )`.mapWith(Number),
        hostnames: sql<string | null>`(
          select string_agg(${devices.hostname}, ', ' order by ${devices.hostname})
          from ${devices} where ${devices.userId} = ${users.id}
        )`,
        // Both come back through the driver's date parsing, which turns a
        // `date` into local midnight and a `timestamp` into a local-time Date.
        // Serialising either of those shifts the value by the server's offset,
        // so Postgres formats them as text and the API hands over exactly what
        // the database holds. The columns are UTC, hence the Z.
        lastSeenAt: sql<string | null>`(
          select to_char(max(${devices.lastSeenAt}), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          from ${devices} where ${devices.userId} = ${users.id}
        )`,
        lastSyncDate: sql<string | null>`(
          select max(${dailySnapshots.date})::text from ${dailySnapshots}
          where ${dailySnapshots.userId} = ${users.id}
        )`,
        totalCostUsd: sql<number>`coalesce((
          select sum(${dailySnapshots.totalCostUsd}) from ${dailySnapshots}
          where ${dailySnapshots.userId} = ${users.id}
        ), 0)`.mapWith(Number),
        totalTokens: sql<number>`coalesce((
          select sum(${dailySnapshots.totalTokens}) from ${dailySnapshots}
          where ${dailySnapshots.userId} = ${users.id}
        ), 0)`.mapWith(Number),
        activeDays: sql<number>`(
          select count(*) from ${dailySnapshots} where ${dailySnapshots.userId} = ${users.id}
        )`.mapWith(Number),
      })
      .from(users)
      .where(eq(users.orgId, jwt.orgId))
      .limit(500)

    const result: AdminUserRow[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      isActive: r.isActive,
      createdAt: new Date(r.createdAt).toISOString(),
      deviceCount: r.deviceCount ?? 0,
      hostnames: r.hostnames ? r.hostnames.split(', ') : [],
      lastSeenAt: r.lastSeenAt ? String(r.lastSeenAt) : null,
      lastSyncDate: toDateString(r.lastSyncDate),
      totalCostUsd: r.totalCostUsd ?? 0,
      totalTokens: r.totalTokens ?? 0,
      activeDays: r.activeDays ?? 0,
    }))

    // 500 rows at most, so the sort is cheaper here than an ORDER BY that would
    // make Postgres run the spend subquery a second time.
    result.sort((a, b) => b.totalCostUsd - a.totalCostUsd || a.name.localeCompare(b.name))
    return result
  })

  // POST /v1/admin/users — create a user (requires admin JWT)
  fastify.post('/admin/users', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    preHandler: requireAdmin(fastify),
  }, async (request, reply) => {
    const body = CreateUserSchema.parse(request.body)
    const jwt = request.user as JwtPayload

    // Admin can only create users in their own org
    const orgId = body.orgId ?? jwt.orgId

    if (orgId !== jwt.orgId) {
      return reply.status(403).send({ error: 'Cannot create users in another organization' })
    }

    try {
      const [user] = await fastify.db
        .insert(users)
        .values({
          orgId,
          email: body.email,
          name: body.name,
        })
        .returning({ id: users.id })

      return { userId: user.id }
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        return reply.status(409).send({ error: 'A user with this email already exists' })
      }
      throw err
    }
  })
}
