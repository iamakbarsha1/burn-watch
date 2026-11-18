import type { FastifyInstance } from 'fastify'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { getStore, newId, runInTxn, type OrgId, type UserId } from '@burn-watch/db'
import { requireAdmin } from '../../plugins/jwt.js'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const CreateInviteSchema = z.object({
  // Trim before validating. An admin pasting an address with a trailing space
  // should get an invite, not a 400.
  email: z.string().trim().email(),
  role: z.enum(['admin', 'manager', 'developer']).default('developer'),
})

const AcceptInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(200),
})

/**
 * The invite token is returned to the admin exactly once and never stored.
 * Only this hash goes in the database, so a dump of the `invites` table cannot
 * be replayed into account creation.
 *
 * Plain SHA-256 rather than a password KDF on purpose: the token is 32 bytes
 * from `randomBytes`, so there is no guessable input to slow an attacker down
 * over. A KDF here would cost latency and buy nothing.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function inviteRoutes(fastify: FastifyInstance) {
  // POST /v1/auth/admin/invites — issue an invite (admin only)
  fastify.post(
    '/admin/invites',
    {
      config: { rateLimit: { max: 50, timeWindow: '1 hour' } },
      preHandler: requireAdmin(fastify),
    },
    async (request, reply) => {
      const body = CreateInviteSchema.parse(request.body)
      const jwt = request.user
      const email = body.email.trim().toLowerCase()

      const existing = await getStore().users.findOne({ email }, { projection: { _id: 1 } })

      if (existing) {
        return reply.status(409).send({ error: 'A user with this email already exists' })
      }

      const token = randomBytes(32).toString('base64url')
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
      const inviteId = newId()

      await getStore().invites.insertOne({
        _id: inviteId,
        orgId: jwt.orgId as OrgId,
        email,
        role: body.role,
        code: hashToken(token),
        expiresAt,
        usedAt: null,
        createdAt: new Date(),
      })

      // The only time the plaintext token exists outside the invitee's link.
      return {
        inviteId,
        email,
        role: body.role,
        token,
        expiresAt: expiresAt.toISOString(),
      }
    },
  )

  // GET /v1/auth/admin/invites — pending invites for the caller's org
  fastify.get(
    '/admin/invites',
    { preHandler: requireAdmin(fastify) },
    async (request) => {
      const jwt = request.user
      // `code` is projected out. Even hashed, it has no reason to leave the
      // database.
      const rows = await getStore().invites.find(
        { orgId: jwt.orgId as OrgId },
        { projection: { code: 0 }, sort: { createdAt: -1 }, limit: 200 },
      )
      return rows.map((r) => ({
        id: r._id,
        email: r.email,
        role: r.role,
        expiresAt: r.expiresAt,
        usedAt: r.usedAt,
        createdAt: r.createdAt,
      }))
    },
  )

  // POST /v1/auth/invites/accept — redeem an invite (public)
  fastify.post(
    '/invites/accept',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = AcceptInviteSchema.parse(request.body)

      const now = new Date()
      const result = await runInTxn(getStore(), async (tx) => {
        // Find and claim in one operation. Unused and unexpired are part of
        // the filter, not a later branch, so an expired or spent invite cannot
        // be redeemed by a code path that forgets to check. Two requests racing
        // with one token cannot both match a still-null `usedAt`.
        const invite = await tx.invites.findOneAndUpdate(
          { code: hashToken(body.token), usedAt: null, expiresAt: { $gt: now } },
          { $set: { usedAt: now } },
        )

        if (!invite) return null

        const userId = newId<UserId>()
        const email = invite.email.toLowerCase()
        await tx.users.insertOne({
          _id: userId,
          orgId: invite.orgId,
          email,
          name: body.name.trim(),
          githubUsername: null,
          role: invite.role,
          isActive: true,
          createdAt: now,
        })

        return { userId, orgId: invite.orgId, email, role: invite.role }
      })

      // One message for every failure. Distinguishing "expired" from "already
      // used" from "no such invite" tells a guesser which tokens were ever real.
      if (!result) {
        return reply.status(400).send({ error: 'Invalid or expired invite' })
      }

      return result
    },
  )
}

// Exported for tests. Keeps the comparison constant-time if a caller ever needs
// to check a token against a stored hash outside a database lookup.
export function tokenMatchesHash(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex')
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
