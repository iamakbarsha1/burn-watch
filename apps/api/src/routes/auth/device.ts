import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Document } from 'mongodb'
import { getStore, newId, runInTxn, type DeviceId, type OrgId, type UserId } from '@burn-watch/db'
import { RegisterDeviceSchema, VerifyDeviceSchema, ApproveDeviceSchema, DeviceSettingsSchema } from '@burn-watch/shared'
import type { AdminDeviceRow, AdminUserRow, DeviceSettings } from '@burn-watch/shared'
import {
  requireAdmin,
  requireAuth,
  requireDashboardAuth,
  deviceTokenIsLive,
  type JwtPayload,
} from '../../plugins/jwt.js'
import { callerAddress } from '../../caller-address.js'
import { audit, auditView } from '../../audit.js'

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

const RevokeDeviceSchema = z.object({
  deviceId: z.string().uuid(),
})

/**
 * Ends every token the device still holds. Scoped to tokens that are not
 * already revoked, so a second call is a no-op rather than stamping a fresh
 * timestamp over an older revocation, and `revoked` counts what this call
 * actually ended.
 */
async function revokeTokensFor(deviceId: string) {
  const result = await getStore().deviceTokens.updateMany(
    { deviceId: deviceId as DeviceId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  )
  return { deviceId, revoked: result.modifiedCount }
}

// Timestamps go out as text formatted by the database, the way Postgres
// formatted them with to_char, so the API hands over exactly what is stored.
// Dates are UTC, hence the Z. A null date formats to null.
const isoSeconds = (date: unknown) => ({ $dateToString: { date, format: '%Y-%m-%dT%H:%M:%SZ' } })

/**
 * The admin roster: one AdminUserRow per user in the org, including users who
 * have never synced. Each $lookup groups inside its own sub-pipeline, so
 * devices and snapshots never multiply each other's rows and no sum comes
 * back scaled by the number of devices a user owns.
 *
 * `_id` stays the `id` the dashboard reads. Cost is micros over 1e6, the same
 * sum `usdFromMicros` would do at the boundary.
 */
export function adminUsersPipeline(orgId: OrgId): Document[] {
  return [
    { $match: { orgId } },
    { $limit: 500 },
    {
      $lookup: {
        from: 'devices',
        localField: '_id',
        foreignField: 'userId',
        pipeline: [{ $project: { _id: 0, hostname: 1, lastSeenAt: 1 } }],
        as: 'devices',
      },
    },
    {
      $lookup: {
        from: 'dailySnapshots',
        localField: '_id',
        foreignField: 'userId',
        pipeline: [
          {
            $group: {
              _id: null,
              lastSyncDate: { $max: '$date' },
              costMicros: { $sum: '$totalCostMicros' },
              totalTokens: { $sum: '$totalTokens' },
              activeDays: { $sum: 1 },
            },
          },
        ],
        as: 'usage',
      },
    },
    { $set: { usage: { $first: '$usage' } } },
    {
      // Every field is an expression so the output keeps this key order.
      $project: {
        _id: 0,
        id: '$_id',
        name: '$name',
        email: '$email',
        role: '$role',
        isActive: '$isActive',
        createdAt: { $dateToString: { date: '$createdAt', format: '%Y-%m-%dT%H:%M:%S.%LZ' } },
        deviceCount: { $size: '$devices' },
        hostnames: { $sortArray: { input: '$devices.hostname', sortBy: 1 } },
        lastSeenAt: isoSeconds({ $max: '$devices.lastSeenAt' }),
        lastSyncDate: { $ifNull: ['$usage.lastSyncDate', null] },
        totalCostUsd: { $divide: [{ $ifNull: ['$usage.costMicros', 0] }, 1e6] },
        totalTokens: { $ifNull: ['$usage.totalTokens', 0] },
        activeDays: { $ifNull: ['$usage.activeDays', 0] },
      },
    },
  ]
}

/**
 * Every device in the org as an AdminDeviceRow, newest activity first.
 * Starts from users because a device carries no orgId. `revoked` is true when
 * the device holds no unrevoked token, the same condition the auth guard checks.
 */
export function adminDevicesPipeline(orgId: OrgId): Document[] {
  return [
    { $match: { orgId } },
    { $lookup: { from: 'devices', localField: '_id', foreignField: 'userId', as: 'device' } },
    { $unwind: '$device' },
    { $sort: { 'device.lastSeenAt': -1 } },
    { $limit: 500 },
    {
      $lookup: {
        from: 'deviceTokens',
        localField: 'device._id',
        foreignField: 'deviceId',
        pipeline: [{ $match: { revokedAt: null } }, { $limit: 1 }, { $project: { _id: 1 } }],
        as: 'live',
      },
    },
    {
      $project: {
        _id: 0,
        id: '$device._id',
        hostname: '$device.hostname',
        platform: '$device.platform',
        lastSeenAt: isoSeconds('$device.lastSeenAt'),
        userName: '$name',
        userEmail: '$email',
        revoked: { $eq: [{ $size: '$live' }, 0] },
        agentVersion: '$device.agentVersion',
        // Devices registered before R0.3 have no claudeVersion field at all.
        claudeVersion: { $ifNull: ['$device.claudeVersion', null] },
      },
    },
  ]
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

    // Emails are stored lowercase, so every lookup lowercases too.
    const email = body.email.trim().toLowerCase()
    const user = await getStore().users.findOne({ email }, { projection: { _id: 1 } })

    if (!user) {
      return reply.status(404).send({
        error: 'User not found. Ask your admin to invite you first.',
      })
    }

    // Create pending device with 15-minute expiry
    const code = generateCode()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000)
    const pendingId = newId()

    await getStore().pendingDevices.insertOne({
      _id: pendingId,
      code,
      email,
      hostname: body.hostname,
      platform: body.platform,
      agentVersion: body.agentVersion,
      expiresAt,
      approvedAt: null,
      verifiedAt: null,
      deviceId: null,
      createdAt: now,
    })

    return {
      pendingId,
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

    const user = await getStore().users.findOne(
      { _id: jwt.userId as UserId },
      { projection: { email: 1 } },
    )

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    // One update decides and records the approval, so two clicks on the same
    // code cannot both win. Matching on the signed-in user's own email is the
    // actual control: approving is only ever possible for your own device.
    const now = new Date()
    const approved = await getStore().pendingDevices.findOneAndUpdate(
      {
        code: body.code,
        email: user.email.toLowerCase(),
        approvedAt: null,
        verifiedAt: null,
        expiresAt: { $gt: now },
      },
      { $set: { approvedAt: now } },
    )

    // Unknown, expired, already approved, already used, or someone else's code
    // all answer the same way, so this cannot be used to probe for live codes.
    if (!approved) {
      return reply.status(400).send({ error: 'Invalid or expired verification code' })
    }

    // No verification code in detail; pendingId names the attempt.
    await audit(request, {
      action: 'device.approve',
      target: { type: 'user', id: jwt.userId, label: user.email },
      detail: { hostname: approved.hostname, platform: approved.platform, pendingId: approved._id },
    })
    return { hostname: approved.hostname, platform: approved.platform }
  })

  // POST /v1/auth/verify-device — step 3: exchange an approved code for tokens
  //
  // The cap is high because the agent polls this endpoint every 10s for up to
  // 15 minutes while it waits for the approval above: 90 requests per laptop
  // per registration. Counted per address that would be seven developers in a
  // shared office before the eighth is locked out of registering at all, so it
  // counts per pendingId instead — a v4 UUID handed only to the caller that
  // registered, and one registration's worth of polling each. Getting a fresh
  // one means passing /register-device, which is still 5 per address per 15
  // minutes, so this cannot be used to buy extra attempts.
  //
  // Reading the body needs `hook: 'preHandler'`; on the default `onRequest`
  // hook nothing is parsed yet. Falls back to the address when the body has no
  // usable pendingId, which the schema below rejects anyway.
  fastify.post('/verify-device', {
    config: {
      rateLimit: {
        max: 600,
        timeWindow: '15 minutes',
        hook: 'preHandler',
        keyGenerator: (request: FastifyRequest) => {
          const pendingId = (request.body as { pendingId?: unknown } | undefined)?.pendingId
          return typeof pendingId === 'string' ? pendingId : callerAddress(request)
        },
      },
    },
  }, async (request, reply) => {
    const body = VerifyDeviceSchema.parse(request.body)

    // One update decides and records the claim, so two concurrent polls on the
    // same approved code cannot both mint a device and tokens. A read followed
    // by a later write left a window where both saw verifiedAt still null.
    const now = new Date()
    const deviceId = newId<DeviceId>()
    const pending = await getStore().pendingDevices.findOneAndUpdate(
      {
        _id: body.pendingId,
        code: body.code,
        approvedAt: { $ne: null },
        verifiedAt: null,
        expiresAt: { $gt: now },
      },
      { $set: { verifiedAt: now, deviceId } },
    )

    if (!pending) {
      return reply.status(400).send({
        error: 'Invalid or expired verification code',
      })
    }

    // Look up user
    const user = await getStore().users.findOne(
      { email: pending.email.toLowerCase() },
      { projection: { _id: 1, orgId: 1 } },
    )

    if (!user) {
      return reply.status(404).send({ error: 'User no longer exists' })
    }

    // Create device
    await getStore().devices.insertOne({
      _id: deviceId,
      userId: user._id,
      hostname: pending.hostname,
      platform: pending.platform,
      agentVersion: pending.agentVersion,
      claudeVersion: null,
      lastSeenAt: now,
      createdAt: now,
    })

    // Sign JWT tokens
    const tokenPayload = { deviceId, userId: user._id, orgId: user.orgId, role: 'device' as const }
    const accessToken = fastify.jwt.access.sign(tokenPayload, { expiresIn: '30d' })
    const refreshToken = fastify.jwt.refresh.sign(tokenPayload, { expiresIn: '90d' })

    // Store token hash for revocation
    const tokenHash = createHash('sha256').update(accessToken).digest('hex')
    await getStore().deviceTokens.insertOne({
      _id: newId(),
      deviceId,
      tokenHash,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      revokedAt: null,
      createdAt: now,
    })

    return {
      accessToken,
      refreshToken,
      deviceId,
      userId: user._id,
      orgId: user.orgId,
    }
  })

  // POST /v1/auth/refresh — verify with refresh secret, issue new access token
  fastify.post('/refresh', async (request, reply) => {
    try {
      const payload = await request.refreshJwtVerify<JwtPayload>()

      // The same guard requireAuth applies, for the same reason and on the
      // same condition: only a device token has a `deviceTokens` document.
      // Without it the revocation undoes itself, because a revoked laptop
      // trades its refresh token for another 30 days of access.
      if (payload.role === 'device' && !(await deviceTokenIsLive(payload.deviceId))) {
        return reply.status(401).send({ error: 'Invalid refresh token' })
      }

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
    // The guard and both inserts share one transaction, so a failed user
    // insert leaves no org behind to lock bootstrap out for good.
    const result = await runInTxn(getStore(), async (tx) => {
      if (await tx.organizations.findOne({}, { projection: { _id: 1 } })) return null
      // Parsed after the guard, as before: a finished bootstrap answers 403
      // whatever the body.
      const body = BootstrapSchema.parse(request.body)

      const now = new Date()
      const orgId = newId<OrgId>()
      const userId = newId<UserId>()
      await tx.organizations.insertOne({
        _id: orgId,
        name: body.orgName,
        slug: body.orgSlug,
        githubOrg: null,
        createdAt: now,
      })
      await tx.users.insertOne({
        _id: userId,
        orgId,
        email: body.email.trim().toLowerCase(),
        name: body.name,
        githubUsername: null,
        role: 'admin',
        isActive: true,
        createdAt: now,
      })
      return { orgId, userId }
    })

    if (!result) {
      return reply.status(403).send({ error: 'Bootstrap already completed. Use /admin/users to add users.' })
    }
    // Unauthenticated: the new admin is the actor.
    const { orgName } = BootstrapSchema.parse(request.body)
    await audit(request, {
      action: 'org.bootstrap',
      target: { type: 'org', id: result.orgId, label: orgName },
      detail: { orgName },
      actor: { userId: result.userId, orgId: result.orgId, role: 'admin' },
    })
    return result
  })

  // GET /v1/auth/admin/users — every user in the caller's org, including the
  // ones who have never synced. The usage reads cannot answer this: they read
  // from daily_snapshots, so a developer with no data simply is not in them, and
  // "who has not onboarded yet" is exactly what an admin needs to see.
  fastify.get('/admin/users', { preHandler: requireAdmin(fastify) }, async (request) => {
    const jwt = request.user as JwtPayload

    const result = await getStore().users.aggregate<AdminUserRow>(
      adminUsersPipeline(jwt.orgId as OrgId),
    )

    // 500 rows at most, so the sort is cheaper here, and localeCompare keeps
    // the name order the Postgres version had.
    result.sort((a, b) => b.totalCostUsd - a.totalCostUsd || a.name.localeCompare(b.name))
    await auditView(request, 'people', undefined)
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

    const userId = newId<UserId>()
    const email = body.email.trim().toLowerCase()
    try {
      await getStore().users.insertOne({
        _id: userId,
        orgId: orgId as OrgId,
        email,
        name: body.name,
        githubUsername: null,
        role: 'developer',
        isActive: true,
        createdAt: new Date(),
      })
    } catch (err: unknown) {
      // 11000 is the users_email unique index.
      if (err instanceof Error && 'code' in err && (err as { code: unknown }).code === 11000) {
        return reply.status(409).send({ error: 'A user with this email already exists' })
      }
      throw err
    }
    await audit(request, {
      action: 'user.create',
      target: { type: 'user', id: userId, label: email },
      detail: { email, role: 'developer' },
    })
    return { userId }
  })

  // GET /v1/auth/admin/devices returns every device in the caller's org, with
  // whether it still holds a live token, so the dashboard has something to
  // drive the revoke button with.
  fastify.get('/admin/devices', { preHandler: requireAdmin(fastify) }, async (request) => {
    const jwt = request.user as JwtPayload

    const rows = await getStore().users.aggregate<AdminDeviceRow>(adminDevicesPipeline(jwt.orgId as OrgId))
    await auditView(request, 'people', undefined)
    return rows
  })

  // GET /v1/auth/admin/device-settings: the org's minimum Claude Code version.
  // No auditView: one version string, no one's data.
  fastify.get('/admin/device-settings', { preHandler: requireAdmin(fastify) }, async (request) => {
    const jwt = request.user as JwtPayload
    const org = await getStore().organizations.findOne(
      { _id: jwt.orgId as OrgId },
      { projection: { minClaudeVersion: 1 } },
    )
    return { minClaudeVersion: org?.minClaudeVersion ?? null } satisfies DeviceSettings
  })

  // PUT /v1/auth/admin/device-settings: a version sets the minimum, null clears it.
  fastify.put('/admin/device-settings', { preHandler: requireAdmin(fastify) }, async (request) => {
    const body = DeviceSettingsSchema.parse(request.body)
    const jwt = request.user as JwtPayload
    await getStore().organizations.updateOne(
      { _id: jwt.orgId as OrgId },
      body.minClaudeVersion
        ? { $set: { minClaudeVersion: body.minClaudeVersion } }
        : { $unset: { minClaudeVersion: '' } },
    )
    await audit(request, {
      action: 'org.min_claude_version',
      target: { type: 'org', id: jwt.orgId, label: null },
      detail: { minClaudeVersion: body.minClaudeVersion },
    })
    return body satisfies DeviceSettings
  })

  // POST /v1/auth/admin/devices/revoke lets an admin end a device's access, the
  // offboarding path. Until this existed the only way to stop a laptop was
  // rotating JWT_SECRET, which signs out everyone.
  fastify.post('/admin/devices/revoke', {
    preHandler: requireAdmin(fastify),
  }, async (request, reply) => {
    const body = RevokeDeviceSchema.parse(request.body)
    const jwt = request.user as JwtPayload

    // The device must hang off a user in the caller's own org.
    const device = await getStore().devices.findOne(
      { _id: body.deviceId as DeviceId },
      { projection: { userId: 1, hostname: 1 } },
    )
    const owner =
      device &&
      (await getStore().users.findOne(
        { _id: device.userId, orgId: jwt.orgId as OrgId },
        { projection: { _id: 1 } },
      ))

    // One answer for "no such device" and "a device in another org", so this
    // cannot be used to learn which device ids are real.
    if (!owner) {
      return reply.status(404).send({ error: 'Device not found' })
    }

    const result = await revokeTokensFor(body.deviceId)
    await audit(request, {
      action: 'device.revoke',
      target: { type: 'device', id: body.deviceId, label: device.hostname ?? null },
      detail: { ownerId: device.userId, hostname: device.hostname ?? null },
    })
    return result
  })

  // POST /v1/auth/revoke-device lets a device end its own access. `burnwatch
  // uninstall` is the caller, and it cannot use the admin route above because
  // a device JWT does not pass requireAdmin.
  fastify.post('/revoke-device', {
    preHandler: requireAuth(fastify),
  }, async (request, reply) => {
    const jwt = request.user as JwtPayload

    if (jwt.role !== 'device' || !jwt.deviceId) {
      return reply.status(403).send({ error: 'Device role required' })
    }

    const result = await revokeTokensFor(jwt.deviceId)
    await audit(request, { action: 'device.self_revoke', target: { type: 'device', id: jwt.deviceId, label: null } })
    return result
  })
}
