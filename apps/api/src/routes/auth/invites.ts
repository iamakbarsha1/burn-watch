import type { FastifyInstance } from 'fastify'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { getStore, newId, runInTxn, teamMemberKey, type OrgId, type TeamId, type UserId } from '@burn-watch/db'
import { requireAdmin } from '../../plugins/jwt.js'
import { audit } from '../../audit.js'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const Role = z.enum(['admin', 'manager', 'developer'])

const CreateInviteSchema = z.object({
  // Trim before validating. An admin pasting an address with a trailing space
  // should get an invite, not a 400.
  email: z.string().trim().email(),
  role: Role.default('developer'),
})

// Rows are checked one by one in the handler, so one bad line in a CSV is
// reported against that line instead of failing the whole upload.
const BulkInviteSchema = z.object({
  rows: z
    .array(z.object({ email: z.string().max(320), role: z.string().max(50).optional(), team: z.string().max(200).optional() }))
    .min(1)
    .max(200),
})

type Invited = { inviteId: string; email: string; role: z.infer<typeof Role>; token: string; expiresAt: string }

async function issueInvite(orgId: OrgId, email: string, role: z.infer<typeof Role>, teamId: TeamId | null): Promise<Invited> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  const inviteId = newId()
  await getStore().invites.insertOne({
    _id: inviteId,
    orgId,
    email,
    role,
    code: hashToken(token),
    teamId,
    expiresAt,
    usedAt: null,
    createdAt: new Date(),
  })
  // The only time the plaintext token exists outside the invitee's link.
  return { inviteId, email, role, token, expiresAt: expiresAt.toISOString() }
}

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

      const invited = await issueInvite(jwt.orgId as OrgId, email, body.role, null)
      await audit(request, {
        action: 'invite.create',
        target: { type: 'invite', id: invited.inviteId, label: email },
        detail: { role: body.role },
      })
      return invited
    },
  )

  // POST /v1/auth/admin/invites/bulk — up to 200 invites from a CSV (admin only).
  // Answers 200 with one result per row, in order; a row error never stops the rest.
  fastify.post(
    '/admin/invites/bulk',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      preHandler: requireAdmin(fastify),
    },
    async (request) => {
      const { rows } = BulkInviteSchema.parse(request.body)
      const orgId = request.user.orgId as OrgId
      const store = getStore()
      const emails = rows.map((r) => r.email.trim().toLowerCase())

      // Two reads for the whole upload. Team names match case-insensitively.
      const taken = new Set(
        (await store.users.find({ email: { $in: emails } }, { projection: { email: 1 } })).map((u) => u.email),
      )
      const teams = new Map(
        (await store.teams.find({ orgId })).map((t) => [t.name.trim().toLowerCase(), t._id]),
      )

      const seen = new Set<string>()
      const results = []
      // One event per upload (Decision 6). Never the invite tokens.
      const created: { email: string; role: string; team: string | null }[] = []
      for (const [i, row] of rows.entries()) {
        const email = emails[i]
        const fail = (error: string) => ({ email, ok: false as const, error })
        const role = Role.safeParse(row.role?.trim().toLowerCase() || 'developer')
        const teamName = row.team?.trim() ?? ''
        const teamId = teamName ? teams.get(teamName.toLowerCase()) : null

        if (!z.string().email().safeParse(email).success) results.push(fail('Not a valid email'))
        else if (!role.success) results.push(fail('Role must be admin, manager or developer'))
        else if (teamId === undefined) results.push(fail(`No team named "${teamName}"`))
        else if (taken.has(email)) results.push(fail('A user with this email already exists'))
        else if (seen.has(email)) results.push(fail('Listed twice in this upload'))
        else {
          seen.add(email)
          results.push({ ok: true as const, ...(await issueInvite(orgId, email, role.data, teamId)) })
          created.push({ email, role: role.data, team: teamId ? teamName : null })
        }
      }
      if (created.length > 0) {
        await audit(request, {
          action: 'invite.bulk',
          target: { type: 'org', id: orgId, label: null },
          detail: { created, failed: rows.length - created.length },
        })
      }
      return { results }
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
      let joinedTeam: TeamId | null = null
      const result = await runInTxn(getStore(), async (tx) => {
        joinedTeam = null
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

        // Join the invite's team, if it still exists in the same org. A team
        // deleted since the invite was made is skipped, not an error.
        if (invite.teamId && (await tx.teams.findOne({ _id: invite.teamId, orgId: invite.orgId }))) {
          await tx.teamMembers.insertOne({
            _id: teamMemberKey(invite.teamId, userId),
            teamId: invite.teamId,
            orgId: invite.orgId,
            userId,
            role: invite.role === 'manager' ? 'manager' : 'member',
            createdAt: now,
          })
          joinedTeam = invite.teamId
        }

        return { userId, orgId: invite.orgId, email, role: invite.role }
      })

      // One message for every failure. Distinguishing "expired" from "already
      // used" from "no such invite" tells a guesser which tokens were ever real.
      if (!result) {
        return reply.status(400).send({ error: 'Invalid or expired invite' })
      }

      // Public route: the new user is the actor. This is where an org role is first set.
      await audit(request, {
        action: 'invite.accept',
        target: { type: 'user', id: result.userId, label: result.email },
        detail: { role: result.role, teamId: joinedTeam },
        actor: { userId: result.userId, orgId: result.orgId, role: result.role },
      })
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
