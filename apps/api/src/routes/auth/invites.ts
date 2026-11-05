import type { FastifyInstance } from 'fastify'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { and, eq, gt, isNull, desc } from 'drizzle-orm'
import { invites, users } from '../../../drizzle/schema.js'
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

      const [existing] = await fastify.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)

      if (existing) {
        return reply.status(409).send({ error: 'A user with this email already exists' })
      }

      const token = randomBytes(32).toString('base64url')
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS)

      const [invite] = await fastify.db
        .insert(invites)
        .values({
          orgId: jwt.orgId,
          email,
          role: body.role,
          code: hashToken(token),
          expiresAt,
        })
        .returning({ id: invites.id })

      // The only time the plaintext token exists outside the invitee's link.
      return {
        inviteId: invite.id,
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
      // No `code` in the selection. Even hashed, it has no reason to leave the
      // database.
      return fastify.db
        .select({
          id: invites.id,
          email: invites.email,
          role: invites.role,
          expiresAt: invites.expiresAt,
          usedAt: invites.usedAt,
          createdAt: invites.createdAt,
        })
        .from(invites)
        .where(eq(invites.orgId, jwt.orgId))
        .orderBy(desc(invites.createdAt))
        .limit(200)
    },
  )

  // POST /v1/auth/invites/accept — redeem an invite (public)
  fastify.post(
    '/invites/accept',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = AcceptInviteSchema.parse(request.body)

      // Unused and unexpired are enforced in the query, not in a later branch,
      // so an expired or spent invite cannot be redeemed by a code path that
      // forgets to check.
      const [invite] = await fastify.db
        .select()
        .from(invites)
        .where(
          and(
            eq(invites.code, hashToken(body.token)),
            isNull(invites.usedAt),
            gt(invites.expiresAt, new Date()),
          ),
        )
        .limit(1)

      // One message for every failure. Distinguishing "expired" from "already
      // used" from "no such invite" tells a guesser which tokens were ever real.
      if (!invite) {
        return reply.status(400).send({ error: 'Invalid or expired invite' })
      }

      const result = await fastify.db.transaction(async (tx) => {
        // Re-check and claim in the same statement. Two requests racing with
        // one token both pass the select above; only the one whose UPDATE
        // matches a still-null `used_at` gets a row back.
        const claimed = await tx
          .update(invites)
          .set({ usedAt: new Date() })
          .where(and(eq(invites.id, invite.id), isNull(invites.usedAt)))
          .returning({ id: invites.id })

        if (claimed.length === 0) return null

        const [user] = await tx
          .insert(users)
          .values({
            orgId: invite.orgId,
            email: invite.email,
            name: body.name.trim(),
            role: invite.role,
          })
          .returning({ id: users.id })

        return { userId: user.id, orgId: invite.orgId, email: invite.email, role: invite.role }
      })

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
